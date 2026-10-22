'use strict';
const { getBrowser } = require('./browser');

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1366, height: 768 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', vp: { width: 1920, height: 1080 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1512, height: 982 }, plat: 'MacIntel' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1600, height: 900 }, plat: 'Linux x86_64' },
];

const SHORTENER_HOSTS = ['ouo.io', 'ouo.press', 'ouo.pw'];

const CF_FAILED = ['verification failed', 'refresh this page', 'troubleshooting documentation'];

const CLICK_WORDS = [
  'continue', 'proceed', 'click here', 'get link', 'get your link', 'skip ad',
  'go to link', 'visit link', 'open link', 'download', 'submit',
];

const pickProfile = () => PROFILES[Math.floor(Math.random() * PROFILES.length)];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isShortener = (h) => SHORTENER_HOSTS.some((d) => h === d || h.endsWith('.' + d));

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

async function snapshot(page) {
  return page.evaluate(() => {
    const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
    const tok = document.querySelector('input[name="cf-turnstile-response"]');
    return {
      host: location.hostname,
      text: t.slice(0, 120),
      tokenLen: tok ? (tok.value || '').length : -1,
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 50)),
      btns: [...document.querySelectorAll('button,a,[role=button],input[type=submit]')]
        .map((e) => (e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 24))
        .filter(Boolean)
        .slice(0, 8),
    };
  }).catch(() => null);
}

async function pageText(page) {
  return page.evaluate(() => (document.body ? document.body.innerText : '').toLowerCase()).catch(() => '');
}

// Wait for Cloudflare's wall to fall. Blank bodies keep us waiting.
async function passCloudflare(page, budgetMs) {
  const t0 = Date.now();
  let reloads = 0;

  while (Date.now() - t0 < budgetMs) {
    const txt = await pageText(page);

    if (CF_FAILED.some((w) => txt.includes(w)) && reloads < 3) {
      reloads++;
      console.log(`        [cf] failure page at ${Math.round((Date.now() - t0) / 1000)}s, reload`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }

    const remaining = budgetMs - (Date.now() - t0);
    if (remaining < 3000) break;

    try {
      await page.waitForFunction(() => {
        const t = (document.body ? document.body.innerText : '').toLowerCase();
        if (!t || t.length < 30) return false;
        return ![
          'performing security verification',
          'checking your browser',
          'just a moment',
          'security service to protect',
          'verifies you are not a bot',
          'verify you are human',
          'enabling javascript',
        ].some((w) => t.includes(w));
      }, { timeout: Math.min(remaining, 12000), polling: 400 });

      console.log(`        [cf] passed in ${Math.round((Date.now() - t0) / 1000)}s`);
      return true;
    } catch { /* loop and re-check */ }
  }
  console.log(`        [cf] GAVE UP after ${Math.round((Date.now() - t0) / 1000)}s`);
  return false;
}

async function waitForTurnstile(page, budgetMs) {
  const poker = setInterval(() => { pokeCheckbox(page).catch(() => {}); }, 3000);
  try {
    await page.waitForFunction(() => {
      const tok = document.querySelector('input[name="cf-turnstile-response"]');
      if (tok && tok.value && tok.value.length > 20) return true;
      const t = (document.body ? document.body.innerText : '').toLowerCase();
      if (!t) return false;
      if (t.includes('success')) return true;
      const stuck = ['checking your browser', 'verifying', 'just a moment'].some((w) => t.includes(w));
      const iframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      return !stuck && !iframe;
    }, { timeout: budgetMs, polling: 400 });
    return true;
  } catch {
    return false;
  } finally {
    clearInterval(poker);
  }
}

async function pokeCheckbox(page) {
  const frame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
  if (!frame) return;
  try {
    const el = await frame.frameElement();
    const box = await el.boundingBox();
    if (box && box.width > 4) {
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await page.waitForTimeout(90);
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      return;
    }
  } catch { /* ignore */ }
  try { await frame.click('body', { timeout: 800 }); } catch { /* ignore */ }
}

async function clickThrough(page, budgetMs) {
  const t0 = Date.now();
  let fellBack = false;

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

    if (!fellBack && Date.now() - t0 > 2500) {
      fellBack = true;
      const b = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button,a,input[type=submit],[role=button]')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.width > 60 && x.r.height > 20 && x.r.top < window.innerHeight)
          .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
        if (!els.length) return null;
        els[0].el.scrollIntoView({ block: 'center' });
        els[0].el.click();
        return 'prominent';
      }).catch(() => null);
      if (b) return b;
    }
    await page.waitForTimeout(450);
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
  ctx.setDefaultTimeout(10000);

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(Math.min(28000, Math.round(budgetMs * 0.35)));

  const out = {
    proxy, ok: false, cf: false, hops: 0, clicks: 0,
    cleared: false, completed: false, final: null, note: '', dbg: null,
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(28000, Math.round(budgetMs * 0.35)) });
    out.ok = true;

    // MULTI-HOP: clear CF -> click -> clear CF -> click ... until off the shortener
    for (let hop = 0; hop < 6; hop++) {
      if (Date.now() > deadline - 3000) { out.note = 'time budget exhausted'; break; }

      const cfOk = await passCloudflare(page, Math.min(22000, deadline - Date.now() - 2500));
      if (!cfOk) { out.note = 'cf never cleared'; break; }
      out.cf = true;

      const host = hostOf(page.url());
      if (host && !isShortener(host)) {
        out.completed = true;
        out.final = page.url();
        break;
      }

      out.cleared = await waitForTurnstile(page, Math.min(9000, Math.max(2000, deadline - Date.now() - 2500)));

      const before = page.url();
      const hit = await clickThrough(page, Math.min(8000, Math.max(2000, deadline - Date.now() - 2000)));
      if (hit) out.clicks++;
      else await page.waitForTimeout(1000);
      out.hops = hop + 1;

      const t0 = Date.now();
      while (Date.now() - t0 < 6000 && page.url() === before) await page.waitForTimeout(350);
    }

    if (!out.completed) {
      out.final = page.url();
      out.dbg = await snapshot(page);
      if (!out.note) out.note = 'never reached destination';
    }
  } catch (e) {
    out.note = String((e && e.message) || e).slice(0, 120);
    out.dbg = await snapshot(page).catch(() => null);
  } finally {
    await ctx.close().catch(() => {});
  }

  return out;
}

module.exports = { attemptVisit };
