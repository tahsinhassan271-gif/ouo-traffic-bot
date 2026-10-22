'use strict';
const { getBrowser } = require('./browser');

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1366, height: 768 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', vp: { width: 1920, height: 1080 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1512, height: 982 }, plat: 'MacIntel' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1600, height: 900 }, plat: 'Linux x86_64' },
];

const SHORTENER_HOSTS = ['ouo.io', 'ouo.press', 'ouo.pw'];

// apostrophe-free markers - the pages use a curly ' that breaks "i'm a human"
const REAL_PAGE = [
  'proceed to the destination',
  'a human',
  'captcha box',
  'this link is safe',
  'payout rates',
];

const CF_WORDS = [
  'performing security verification',
  'security service to protect',
  'verifies you are not a bot',
  'enabling javascript',
  'just a moment',
];

const CF_FAILED = ['refresh this page', 'troubleshooting documentation'];

const CLICK_SELECTORS = [
  '#btn-main', '#btn6', '#btn5', '#inlink', '#btn-main-2',
  'a#continue', '#invisibleCaptchaShortlink',
];

const CLICK_WORDS = [
  'human', 'captcha', 'continue', 'proceed', 'click here',
  'cannot submit', 'get link', 'get your link', 'skip ad',
  'go to link', 'visit link', 'open link', 'destination',
];

const pickProfile = () => PROFILES[Math.floor(Math.random() * PROFILES.length)];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isShortener = (h) => SHORTENER_HOSTS.some((d) => h === d || h.endsWith('.' + d));
const norm = (s) => (s || '').replace(/[\u2018\u2019\u02bc\u2032\u0060\u00b4]/g, "'");

function stealth() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  const q = navigator.permissions && navigator.permissions.query;
  if (q) {
    navigator.permissions.query = (p) =>
      p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(navigator.permissions, p);
  }
}

function classifyFn() {
  const t = (document.body ? document.body.innerText : '')
    .toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const real = ['proceed to the destination', 'a human', 'captcha box', 'this link is safe', 'payout rates'];
  if (real.some((w) => t.includes(w))) return 'real';
  if (!t || t.length < 30) return 'blank';
  const cf = ['performing security verification', 'security service to protect',
              'verifies you are not a bot', 'enabling javascript', 'just a moment'];
  if (cf.some((w) => t.includes(w))) return 'cf';
  if (document.querySelector('form#challenge-form')) return 'cf';
  return 'clear';
}

async function snapshot(page) {
  return page.evaluate(() => {
    const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
    const l = t.toLowerCase().replace(/[\u2018\u2019]/g, "'");
    let state = 'OTHER';
    if (['proceed to the destination', 'a human', 'captcha box', 'this link is safe'].some((w) => l.includes(w))) state = 'REAL';
    else if (['performing security verification', 'security service to protect'].some((w) => l.includes(w))) state = 'CF';
    return {
      host: location.hostname,
      state,
      text: t.slice(0, 110),
      btns: [...document.querySelectorAll('button,a,[role=button],input[type=submit]')]
        .map((e) => (e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 22))
        .filter(Boolean)
        .slice(0, 8),
    };
  }).catch(() => null);
}

async function pageText(page) {
  const t = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  return norm(t).toLowerCase();
}

// Wait for Cloudflare to fall, or for the real page to appear
async function passCloudflare(page, budgetMs) {
  const t0 = Date.now();
  let reloads = 0;

  while (Date.now() - t0 < budgetMs) {
    const txt = await pageText(page);

    if (REAL_PAGE.some((w) => txt.includes(w))) {
      console.log(`        [cf] REAL page at ${Math.round((Date.now() - t0) / 1000)}s`);
      return true;
    }

    if (CF_FAILED.some((w) => txt.includes(w)) && reloads < 1) {
      reloads++;
      console.log(`        [cf] cf-failure, reload at ${Math.round((Date.now() - t0) / 1000)}s`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    const remaining = budgetMs - (Date.now() - t0);
    if (remaining < 2000) break;

    try {
      const state = await page.evaluate(classifyFn).catch(() => 'blank');
      if (state === 'real' || state === 'clear') {
        console.log(`        [cf] clear(${state}) at ${Math.round((Date.now() - t0) / 1000)}s`);
        return true;
      }
    } catch { /* ignore */ }

    await page.waitForTimeout(500);
  }
  console.log(`        [cf] GAVE UP after ${Math.round((Date.now() - t0) / 1000)}s`);
  return false;
}

async function waitForTurnstile(page, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const txt = await pageText(page);
    if (txt.includes('success')) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

async function clickThrough(page, budgetMs) {
  const t0 = Date.now();
  let fellBack = false;

  while (Date.now() - t0 < budgetMs) {
    for (const sel of CLICK_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible())) continue;
        await loc.click({ timeout: 2000 });
        return sel;
      } catch { /* next */ }
    }

    const hit = await page.evaluate((words) => {
      const els = [...document.querySelectorAll('a,button,input[type=submit],[role=button],div[onclick]')];
      for (const el of els) {
        const t = (el.innerText || el.value || el.textContent || '')
          .trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
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

    if (!fellBack && Date.now() - t0 > 2500) {
      fellBack = true;
      const b = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button,a,input[type=submit],[role=button]')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.width > 50 && x.r.height > 18 && x.r.top < window.innerHeight)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        if (!els.length) return null;
        els[0].el.scrollIntoView({ block: 'center' });
        els[0].el.click();
        return 'prominent';
      }).catch(() => null);
      if (b) return b;
    }
    await page.waitForTimeout(400);
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
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(proxy ? { proxy: { server: proxy.includes('://') ? proxy : `http://${proxy}` } } : {}),
  });
  await ctx.addInitScript(stealth);
  ctx.setDefaultTimeout(10000);

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(Math.min(25000, Math.round(budgetMs * 0.25)));

  const out = {
    proxy, ok: false, cf: false, hops: 0, clicks: 0,
    cleared: false, completed: false, final: null, note: '', dbg: null,
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(25000, Math.round(budgetMs * 0.25)) });
    out.ok = true;

    for (let hop = 0; hop < 5; hop++) {
      if (Date.now() > deadline - 6000) { out.note = 'budget exhausted'; break; }

      let cfOk = await passCloudflare(page, Math.min(45000, deadline - Date.now() - 6000));

      if (!cfOk) {
        // one recovery attempt: reload and wait again
        console.log('        [cf] retry after reload');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
        cfOk = await passCloudflare(page, Math.min(40000, deadline - Date.now() - 4000));
      }
      if (!cfOk) { out.note = 'cf never cleared'; break; }
      out.cf = true;

      const host = hostOf(page.url());
      if (host && !isShortener(host)) { out.completed = true; out.final = page.url(); break; }

      out.cleared = await waitForTurnstile(page, Math.min(4000, Math.max(1200, deadline - Date.now() - 3000)));

      const before = page.url();
      const hit = await clickThrough(page, Math.min(6000, Math.max(1500, deadline - Date.now() - 2000)));
      if (hit) out.clicks++;
      else await page.waitForTimeout(600);
      out.hops = hop + 1;
      console.log(`        [hop${out.hops}] clicked=${hit || 'none'} url=${page.url().slice(0, 60)}`);

      const t0 = Date.now();
      while (Date.now() - t0 < 5000 && page.url() === before) await page.waitForTimeout(300);
    }

    if (!out.completed) {
      out.final = page.url();
      out.dbg = await snapshot(page);
      if (!out.note) out.note = 'never reached destination';
    }
  } catch (e) {
    out.note = String((e && e.message) || e).slice(0, 110);
    out.dbg = await snapshot(page).catch(() => null);
  } finally {
    await ctx.close().catch(() => {});
  }

  return out;
}

module.exports = { attemptVisit };
