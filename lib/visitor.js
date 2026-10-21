'use strict';
const { getBrowser } = require('./browser');

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1366, height: 768 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', vp: { width: 1920, height: 1080 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1512, height: 982 }, plat: 'MacIntel' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1600, height: 900 }, plat: 'Linux x86_64' },
];

const CLICK_WORDS = [
  'continue', 'proceed', 'click here', 'get link', 'get your link', 'skip ad',
  'go to link', 'visit link', 'open link', 'download', 'i am human', 'verify',
];

const STUCK_WORDS = ['checking your browser', 'verifying', 'just a moment', 'verify you are human', 'one moment'];

const pickProfile = () => PROFILES[Math.floor(Math.random() * PROFILES.length)];

function stealth() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  const q = navigator.permissions && navigator.permissions.query;
  if (q) {
    navigator.permissions.query = (p) =>
      p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(navigator.permissions, p);
  }
}

async function turnstileCleared(page, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const stuck = STUCK_WORDS.some((w) => (txt || '').toLowerCase().includes(w));
    if (!stuck) return true;

    for (const f of page.frames()) {
      if (f.url().includes('challenges.cloudflare.com')) {
        try { await f.click('body', { timeout: 1200 }); } catch { /* ignore */ }
      }
    }
    await page.waitForTimeout(900);
  }
  return false;
}

async function clickThrough(page, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const hit = await page.evaluate((words) => {
      const els = [...document.querySelectorAll('a,button,input[type=submit],[role=button],div[onclick]')];
      for (const el of els) {
        const t = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
        if (!t || t.length > 60 || el.disabled) continue;
        if (!words.some((w) => t.includes(w))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return t.slice(0, 40);
      }
      return null;
    }, CLICK_WORDS).catch(() => null);

    if (hit) return hit;
    await page.waitForTimeout(700);
  }
  return null;
}

async function waitForExit(page, startHost, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    let host = '';
    try { host = new URL(page.url()).hostname; } catch { /* ignore */ }
    if (host && host !== startHost && !host.endsWith('ouo.io') && !host.endsWith('ouo.press')) {
      return page.url();
    }
    await page.waitForTimeout(600);
  }
  return null;
}

async function attemptVisit(url, proxy, budgetMs) {
  const browser = await getBrowser();
  const p = pickProfile();
  const deadline = Date.now() + budgetMs;

  const ctx = await browser.newContext({
    userAgent: p.ua,
    viewport: p.vp,
    platform: p.plat,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(proxy ? { proxy: { server: proxy.includes('://') ? proxy : `http://${proxy}` } } : {}),
  });
  await ctx.addInitScript(stealth);
  ctx.setDefaultTimeout(12000);

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(Math.min(20000, Math.round(budgetMs * 0.5)));

  const out = {
    proxy, profile: p.plat, ok: false, clicks: 0,
    cleared: false, completed: false, final: null, note: '',
  };

  try {
    let startHost = '';
    try { startHost = new URL(url).hostname; } catch { /* ignore */ }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(20000, Math.round(budgetMs * 0.5)) });
    out.ok = true;

    out.cleared = await turnstileCleared(page, Math.min(11000, Math.max(3000, deadline - Date.now() - 5000)));

    for (let round = 0; round < 3 && Date.now() < deadline - 1500; round++) {
      const hit = await clickThrough(page, 6000);
      if (hit) out.clicks++;

      const left = await waitForExit(page, startHost, Math.min(6000, Math.max(1500, deadline - Date.now() - 500)));
      if (left) { out.final = left; out.completed = true; break; }
    }

    if (!out.completed) {
      out.final = page.url();
      out.note = out.cleared ? 'clicked but never left shortener' : 'challenge not cleared';
    }
  } catch (e) {
    out.note = String((e && e.message) || e).slice(0, 150);
  } finally {
    await ctx.close().catch(() => {});
  }

  return out;
}

module.exports = { attemptVisit };
