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

const TURNSTILE_HINTS = [
  'checking your browser', 'verifying', "i'm a human",
  'just a moment', 'verify you are human', 'verification',
];

async function passTurnstile(page, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const body = (await page.content().catch(() => '')).toLowerCase();
    const blocked = TURNSTILE_HINTS.some((h) => body.includes(h));
    if (!blocked) return true;

    const frame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
    if (frame) {
      try {
        await frame.click('input[type="checkbox"]', { timeout: 1500 });
      } catch {
        try { await frame.click('body', { timeout: 1500 }); } catch { /* ignore */ }
      }
    }
    await page.waitForTimeout(1200);
  }
  return false;
}

async function attemptVisit(url, proxy, budgetMs) {
  const browser = await getBrowser();

  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(proxy ? { proxy: { server: proxy.includes('://') ? proxy : `http://${proxy}` } } : {}),
  });
  ctx.setDefaultTimeout(15000);

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(Math.min(budgetMs, 35000));

  const out = { proxy, ok: false, clicked: false, completed: false, final: null, note: '' };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(budgetMs, 35000) });
    out.ok = true;

    await passTurnstile(page, Math.max(4000, Math.min(budgetMs - 8000, 12000)));

    for (const sel of CONTINUE_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible())) continue;
        await loc.click({ timeout: 3000 });
        out.clicked = true;
        break;
      } catch { /* try next selector */ }
    }

    const hold = Math.max(6000, Math.min(budgetMs - 9000, 14000));
    await page.waitForTimeout(hold);

    out.final = page.url();
    out.completed = true;
  } catch (e) {
    out.note = String((e && e.message) || e).slice(0, 160);
  } finally {
    await ctx.close().catch(() => {});
  }

  return out;
}

module.exports = { attemptVisit };
