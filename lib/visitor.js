'use strict';
const { getBrowser } = require('./browser');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTINUE_SELECTORS = [
  '#btn-main', '#btn6', '#btn5', '#btn7', '#btn8',
  '#invisibleCaptchaShortlink', '#continue', '#getLink', '#btn-continue',
  '.btn-continue', '.continue-btn', 'input[type="submit"]',
  'button:has-text("Continue")', 'a:has-text("Continue")',
  'button:has-text("Proceed")', 'a:has-text("Proceed")',
  'button:has-text("Click here to continue")',
  'a:has-text("Click here to continue")',
  'button:has-text("Get Link")', 'a:has-text("Get Link")',
  'button:has-text("Skip Ad")', 'a:has-text("Skip Ad")',
];

// Challenge-specific phrases only. A generic word like "verification" appears on
// plenty of ordinary pages and used to mark them as blocked.
const CHALLENGE_HINTS = [
  'checking your browser',
  'verifying you are human',
  'verify you are human',
  "i'm a human",
  'just a moment',
  'cf-challenge',
  'challenge-platform',
  'enable javascript and cookies to continue',
  'checking if the site connection is secure',
];

const HARD_MAX_MS = 55000;
const MAX_CLICK_ROUNDS = 3;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

async function isBlocked(page) {
  const challengeFrame = page
    .frames()
    .some((f) => /challenges\.cloudflare\.com|challenge-platform/.test(f.url()));
  if (challengeFrame) return true;

  const body = (await page.content().catch(() => '')).toLowerCase();
  return CHALLENGE_HINTS.some((h) => body.includes(h));
}

async function passTurnstile(page, deadline) {
  while (Date.now() < deadline) {
    if (!(await isBlocked(page))) return true;

    const frame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (frame) {
      try {
        await frame.click('input[type="checkbox"]', { timeout: 1500 });
      } catch {
        try { await frame.click('body', { timeout: 1500 }); } catch { /* ignore */ }
      }
    }
    await page.waitForTimeout(clamp(deadline - Date.now(), 250, 1000)).catch(() => {});
  }
  return !(await isBlocked(page));
}

async function clickContinue(page, deadline) {
  for (const sel of CONTINUE_SELECTORS) {
    if (Date.now() >= deadline) return false;
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible())) continue;
      await loc.click({ timeout: clamp(deadline - Date.now(), 500, 2500) });
      return true;
    } catch { /* try next selector */ }
  }
  return false;
}

/**
 * Visit `url` through `proxy` (or direct when null).
 *
 * `completed` is only true when the page actually loaded, no challenge was left
 * on screen, and we either clicked a continue control or ended up on a different
 * host. Merely reaching the shortener landing page does not count as a view.
 */
async function attemptVisit(url, proxy, budgetMs = 40000) {
  const started = Date.now();
  const deadline = started + clamp(Number(budgetMs) || 40000, 5000, HARD_MAX_MS);
  const remaining = () => deadline - Date.now();

  const out = {
    proxy, ok: false, clicked: false, completed: false, blocked: false,
    final: null, note: '', elapsedMs: 0,
  };

  let ctx = null;
  try {
    const browser = await getBrowser();

    ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      ...(proxy ? { proxy: { server: proxy.includes('://') ? proxy : `http://${proxy}` } } : {}),
    });
    ctx.setDefaultTimeout(12000);

    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(clamp(remaining() - 4000, 5000, 25000));

    let startHost = '';
    try { startHost = new URL(url).hostname.toLowerCase(); } catch { /* ignore */ }

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: clamp(remaining() - 8000, 5000, 25000),
    });
    out.ok = true;

    out.blocked = !(await passTurnstile(page, Date.now() + clamp(remaining() - 8000, 2000, 7000)));

    for (let round = 0; round < MAX_CLICK_ROUNDS && remaining() > 4000; round++) {
      const before = page.url();
      const clicked = await clickContinue(page, Date.now() + clamp(remaining() - 4000, 800, 3500));
      if (clicked) out.clicked = true;

      await page.waitForTimeout(clamp(remaining() - 3500, 800, 3000)).catch(() => {});
      try {
        await page.waitForLoadState('domcontentloaded', {
          timeout: clamp(remaining() - 2500, 500, 8000),
        });
      } catch { /* page may never settle */ }

      if (!clicked && page.url() === before) break;
    }

    out.final = page.url();

    let finalHost = '';
    try { finalHost = new URL(out.final).hostname.toLowerCase(); } catch { /* ignore */ }
    const leftShortener = Boolean(startHost && finalHost && finalHost !== startHost);

    out.completed = out.ok && !out.blocked && (out.clicked || leftShortener);

    if (!out.completed && !out.note) {
      out.note = out.blocked ? 'challenge not cleared' : 'no continue control found';
    }
  } catch (e) {
    // Playwright launch errors span several lines; keep logs and CSV readable.
    out.note = String((e && e.message) || e).replace(/\s+/g, ' ').trim().slice(0, 160);
  } finally {
    if (ctx) {
      await Promise.race([
        ctx.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
  }

  out.elapsedMs = Date.now() - started;
  return out;
}

module.exports = { attemptVisit };
