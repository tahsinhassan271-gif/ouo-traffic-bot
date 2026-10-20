'use strict';
const { getBrowser, summarizeError } = require('./browser');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STEP_SELECTORS = [
  '#btn-main', '#btn6', '#btn5', '#btn7', '#btn8',
  '#invisibleCaptchaShortlink', '#continue', '#getLink', '#getlink', '#btn-continue',
  '.btn-continue', '.continue-btn', '.get-link',
  'input[type="submit"]',
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

// Hosts that only ever act as an intermediate hop.
const SHORTENER_HOSTS = [
  'ouo.io', 'ouo.press', 'ouo.today', 'ouo.pw',
];

const HARD_MAX_MS = 75000;
const MAX_ROUNDS = 4;
// Time actually spent on the final page. A visit that bounces in half a second
// is exactly what the shortener's own fraud filter throws away.
const DESTINATION_DWELL_MS = 5000;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));
const hostOf = (u) => {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
};
const isShortenerHost = (host) =>
  SHORTENER_HOSTS.some((h) => host === h || host.endsWith('.' + h));

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

/**
 * Wait until one of the continue controls is visible AND enabled.
 * ouo.io disables its button while a countdown runs, so clicking immediately
 * used to silently do nothing.
 */
async function waitForStep(page, deadline) {
  while (Date.now() < deadline) {
    for (const sel of STEP_SELECTORS) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible())) continue;
        if (!(await loc.isEnabled())) continue;
        return { sel, loc };
      } catch { /* try next selector */ }
    }
    await page.waitForTimeout(clamp(deadline - Date.now(), 200, 800)).catch(() => {});
  }
  return null;
}

/**
 * Visit `url` through `proxy` (or direct when null).
 *
 * `completed` means the shortener was actually left: the final page must be on a
 * different hostname than the link we opened and must not be a shortener itself.
 * Clicking a button is not proof of anything, so it is no longer sufficient.
 */
async function attemptVisit(url, proxy, budgetMs = 60000) {
  const started = Date.now();
  const deadline = started + clamp(Number(budgetMs) || 60000, 8000, HARD_MAX_MS);
  const remaining = () => deadline - Date.now();

  const out = {
    proxy,
    ok: false,
    clicked: false,
    blocked: false,
    completed: false,
    final: null,
    startHost: hostOf(url),
    finalHost: '',
    clicks: 0,
    steps: [],
    note: '',
    elapsedMs: 0,
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

    // The shortener often opens the destination in a new tab. Track every page in
    // the context and follow the newest one, otherwise a successful pass looks
    // like "never left ouo.io".
    const pages = [];
    ctx.on('page', (p) => { pages.push(p); });

    let page = await ctx.newPage();
    pages.push(page);
    page.setDefaultNavigationTimeout(clamp(remaining() - 5000, 5000, 25000));

    const newestPage = () => {
      for (let i = pages.length - 1; i >= 0; i--) {
        if (!pages[i].isClosed()) return pages[i];
      }
      return page;
    };

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: clamp(remaining() - 10000, 5000, 25000),
    });
    out.ok = true;

    out.blocked = !(await passTurnstile(page, Date.now() + clamp(remaining() - 15000, 2000, 7000)));

    for (let round = 0; round < MAX_ROUNDS && remaining() > 7000; round++) {
      const target = await waitForStep(page, Date.now() + clamp(remaining() - 9000, 1500, 15000));
      if (!target) break;

      const from = page.url();
      try {
        await Promise.allSettled([
          page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: clamp(remaining() - 6000, 3000, 15000),
          }).catch(() => null),
          target.loc.click({ timeout: 4000 }),
        ]);
      } catch { /* the click may still have navigated */ }

      out.clicked = true;
      out.clicks++;

      // Let ads, popups and redirects settle between steps.
      await page.waitForTimeout(clamp(remaining() - 5000, 800, 4000)).catch(() => {});
      const current = newestPage();
      if (current !== page) await current.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      page = current;
      page.setDefaultNavigationTimeout(clamp(remaining() - 4000, 3000, 15000));
      out.steps.push({ round: round + 1, selector: target.sel, from, to: page.url() });

      const toHost = hostOf(page.url());
      if (toHost && toHost !== out.startHost && !isShortenerHost(toHost)) break;
    }

    // Stay on the final page long enough for a real view to register.
    page = newestPage();
    await page.waitForTimeout(clamp(Math.min(DESTINATION_DWELL_MS, remaining() - 1500), 500, DESTINATION_DWELL_MS))
      .catch(() => {});

    out.final = page.url();
    out.finalHost = hostOf(out.final);

    const leftShortener =
      Boolean(out.finalHost) &&
      out.finalHost !== out.startHost &&
      !isShortenerHost(out.finalHost);

    out.completed = out.ok && !out.blocked && leftShortener;

    if (!out.completed && !out.note) {
      if (out.blocked) out.note = 'challenge not cleared';
      else if (!out.clicked) out.note = `no enabled continue control (${out.finalHost || 'no page'})`;
      else out.note = `never left ${out.startHost} after ${out.clicks} click(s)`;
    }
  } catch (e) {
    // Keep the line that actually explains the failure (exit code, missing lib),
    // not the argv dump Playwright prints first.
    out.note = summarizeError(e);
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

module.exports = { attemptVisit, isShortenerHost };
