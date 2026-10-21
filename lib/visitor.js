'use strict';
const { getBrowser } = require('./browser');

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1366, height: 768 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', vp: { width: 1920, height: 1080 }, plat: 'Win32' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1512, height: 982 }, plat: 'MacIntel' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', vp: { width: 1600, height: 900 }, plat: 'Linux x86_64' },
];

// Cloudflare's interstitial - these mean "still working, do not touch"
const CF_STUCK = [
  'performing security verification',
  'checking your browser',
  'just a moment',
  'security service to protect',
  'verifies you are not a bot',
  'verify you are human',
  'enabling javascript',
  'one more step',
];

// Cloudflare gave up on us
const CF_FAILED = ['verification failed', 'refresh this page', 'troubleshooting documentation'];

const CLICK_WORDS = [
  'continue', 'proceed', 'click here', 'get link', 'get your link', 'skip ad',
  'go to link', 'visit link', 'open link', 'download', 'submit',
];

const pickProfile = () => PROFILES[Math.floor(Math.random() * PROFILES.length)];

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
      text: t.slice(0, 150),
      tokenLen: tok ? (tok.value || '').length : -1,
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 60)),
      btns: [...document.querySelectorAll('button,a,[role=button],input[type=submit]')]
        .map((e) => (e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 28))
        .filter(Boolean)
        .slice(0, 10),
    };
  }).catch(() => null);
}

async function pageText(page) {
  return page.evaluate(() => (document.body ? document.body.innerText : '').toLowerCase()).catch(() => '');
}

// WAIT for Cloudflare, touching nothing. Reload if it hands us the failure page.
async function passCloudflare(page, budgetMs) {
  const t0 = Date.now();
  let reloads = 0;

  while (Date.now() - t0 < budgetMs) {
    const txt = await pageText(page);

    if (!CF_STUCK.some((w) => txt.includes(w))) return true;   // interstitial gone

    if (CF_FAILED.some((w) => txt.includes(w)) && reloads < 2) {
      reloads++;
      console.log(`        [cf] failure page, reload ${reloads}`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }
    await page.waitForTimeout(700);
  }
  return false;
}

// ouo's OWN turnstile, only after Cloudflare is done
async function waitForTurnstile(page, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const s = await page.evaluate(() => {
      const tok = document.querySelector('input[name="cf-turnstile-response"]');
      const body = (document.body ? document.body.innerText : '').toLowerCase();
      return {
        token: tok ? (tok.value || '') : '',
        success: body.includes('success'),
        stuck: ['checking your browser', 'verifying', 'just a moment'].some((w) => body.includes(w)),
        iframe: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      };
    }).catch(() => ({ token: '', success: false, stuck: false, iframe: false }));

    if (s.token && s.token.length > 20) return true;
    if (s.success) return true;
    if (!s.stuck && !s.iframe) return true;

    if (s.iframe && Date.now() - t0 > 2000) await pokeCheckbox(page);
    await page.waitForTimeout(600);
  }
  return false;
}

async function pokeCheckbox(page) {
  const frame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
  if (!frame) return;
  try {
    const el = await frame.frameElement();
    const box = await el.boundingBox();
    if (box && box.width > 4) {
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await page.waitForTimeout(100);
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      return;
    }
  } catch { /* ignore */ }
  try { await frame.click('body', { timeout: 900 }); } catch { /* ignore */ }
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
    await page.waitForTimeout(500);
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
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...(proxy ? { proxy: { server: proxy.includes('://') ? proxy : `http://${proxy}` } } : {}),
  });
  await ctx.addInitScript(stealth);
  ctx.setDefaultTimeout(10000);

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(Math.min(25000, Math.round(budgetMs * 0.5)));

  const out = {
    proxy, ok: false, cf: false, clicks: 0, cleared: false,
    completed: false, final: null, note: '', dbg: null,
  };

  try {
    let startHost = '';
    try { startHost = new URL(url).hostname; } catch { /* ignore */ }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(25000, Math.round(budgetMs * 0.5)) });
    out.ok = true;

    // STAGE 1 - Cloudflare interstitial. Touch nothing until it's gone.
    out.cf = await passCloudflare(page, Math.min(34000, Math.round(budgetMs * 0.68)));

    if (!out.cf) {
      out.note = 'cloudflare interstitial never cleared';
      out.dbg = await snapshot(page);
      return out;
    }

    // STAGE 2 - ouo's own turnstile
    out.cleared = await waitForTurnstile(page, Math.min(9000, Math.max(2500, deadline - Date.now() - 5000)));

    // STAGE 3 - click through
    for (let round = 0; round < 3 && Date.now() < deadline - 1200; round++) {
      const hit = await clickThrough(page, 6000);
      if (hit) out.clicks++;
      const left = await waitForExit(page, startHost, Math.min(6000, Math.max(1200, deadline - Date.now() - 400)));
      if (left) { out.final = left; out.completed = true; break; }
    }

    if (!out.completed) {
      out.final = page.url();
      out.note = out.cleared ? 'cleared but never left shortener' : 'turnstile not cleared';
      out.dbg = await snapshot(page);
    }
  } catch (e) {
    out.note = String((e && e.message) || e).slice(0, 130);
    out.dbg = await snapshot(page).catch(() => null);
  } finally {
    await ctx.close().catch(() => {});
  }

  return out;
}

module.exports = { attemptVisit };
