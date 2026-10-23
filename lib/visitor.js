'use strict';
/* lib/visitor.js
 * One visit attempt through one proxy.
 * EVERY Playwright call is wrapped in a hard Promise.race cap, so a half-open
 * proxy socket can never freeze the run loop (the 992s hang). */

const B = require('./browser');

const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

const NAV_MS        = n(process.env.NAV_TIMEOUT_MS, 20000);
const EVAL_MS       = n(process.env.EVAL_TIMEOUT_MS, 7000);
const CLICK_MS      = n(process.env.CLICK_TIMEOUT_MS, 6000);
const CF_BUDGET_MS  = n(process.env.CF_BUDGET_MS, 48000);
const CF_MAX_RELOAD = n(process.env.CF_MAX_RELOADS, 5);
const CF_MAX_RESET  = n(process.env.CF_MAX_RESETS, 1);
const VISIT_BUDGET  = n(process.env.VISIT_BUDGET_MS, 95000);
const MAX_HOPS      = n(process.env.MAX_HOPS, 8);
const HOP_WAIT_MS   = n(process.env.HOP_WAIT_MS, 2000);
const CTX_MS        = n(process.env.CTX_TIMEOUT_MS, 20000);
const IND           = '        ';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = t0 => Math.round((Date.now() - t0) / 1000);
const shortErr = e => String((e && e.message) || e || '').split('\n')[0].slice(0, 140);

/* ---- hard cap helper: nothing is allowed to await forever ---- */
function withTimeout(promise, ms, label, onTimeout) {
  let t = null;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => {
      if (onTimeout) { try { onTimeout(); } catch (_) {} }
      rej(new Error('TIMEOUT ' + label + ' ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), guard])
    .finally(() => { if (t) clearTimeout(t); });
}

const norm = s => String(s == null ? '' : s)
  .replace(/[\u2018\u2019\u02bc]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', loc: 'en-US', tz: 'America/New_York' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', loc: 'en-GB', tz: 'Europe/London' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', loc: 'en-US', tz: 'America/Chicago' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', loc: 'en-US', tz: 'America/Denver' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', loc: 'en-US', tz: 'America/Los_Angeles' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', loc: 'en-US', tz: 'America/New_York' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', loc: 'en-CA', tz: 'America/Toronto' },
  { ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', loc: 'en-US', tz: 'America/New_York' },
];

function proxyUrl(p) {
  let s = String(p || '').trim();
  if (!s) return null;
  s = s.replace(/^[a-z0-9]+:\/\//i, '');
  return 'http://' + s;
}

/* ---- page snapshot ---- */
async function snapshot(page) {
  try {
    return await withTimeout(page.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const btns = Array.from(document.querySelectorAll('button,a,input[type=submit],[role=button]'))
        .map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 10);
      return {
        host: location.host,
        href: location.href,
        title: document.title || '',
        text: (body || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        btns,
      };
    }), EVAL_MS, 'snapshot');
  } catch (_) { return null; }
}

/* ---- cloudflare detection: EXCLUSIVE wording (must not appear on the real ouo page) ---- */
const CF_WORDS = [
  'performing security verification',
  'checking if the site connection is secure',
  'verify you are human',
  'just a moment',
  'enable javascript and cookies',
  'attention required',
];
const CF_TITLES = ['just a moment', 'attention required'];

function isCf(snap) {
  if (!snap) return false;
  const t = norm(snap.text);
  const ti = norm(snap.title);
  if (CF_WORDS.some(w => t.includes(w))) return true;
  if (CF_TITLES.some(w => ti.includes(w))) return true;
  return false;
}

const OUO_HOSTS = ['ouo.io', 'ouo.press', 'asdfix.com', 'ouo.pw'];
const hostOf = h => String(h || '').replace(/^www\./, '').toLowerCase();
const isOuo = h => { const x = hostOf(h); return OUO_HOSTS.some(o => x === o || x.endsWith('.' + o)); };
const isDest = h => { const x = hostOf(h); return !!x && !isOuo(x); };

/* ---- navigation helpers ---- */
async function tryReload(page) {
  try {
    await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'reload');
  } catch (_) {
    try { page.evaluate(() => location.reload()); } catch (_) {}
  }
  await sleep(250);
}

async function tryGoto(page, url) {
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
  } catch (_) {}
  await sleep(250);
}

/* ---- cloudflare stall-loop ---- */
async function passCf(page, home, log) {
  const out = { cleared: false, wasCf: false, stuck: false };
  const t0 = Date.now();
  let reloads = 0, resets = 0, blankSince = Date.now();

  await sleep(400);

  for (;;) {
    if (Date.now() - t0 > CF_BUDGET_MS) { out.stuck = true; return out; }

    const snap = await snapshot(page);
    const len = snap && snap.text ? snap.text.length : 0;

    if (len < 25) {
      if (Date.now() - blankSince > 12000) {
        out.cleared = true;
        log(`${IND}[cf] blank-clear at ${sec(t0)}s`);
        return out;
      }
      await sleep(600);
      continue;
    }
    blankSince = Date.now();

    if (isCf(snap)) {
      out.wasCf = true;
      if (reloads < CF_MAX_RELOAD) {
        reloads++;
        log(`${IND}[cf] stall-reload ${reloads} at ${sec(t0)}s`);
        await tryReload(page);
        continue;
      }
      if (resets < CF_MAX_RESET) {
        resets++; reloads = 0;
        log(`${IND}[cf] hard-reset ${resets} at ${sec(t0)}s`);
        await tryGoto(page, home);
        continue;
      }
      await sleep(1500);
      continue;
    }

    out.cleared = true;
    log(`${IND}[cf] ${out.wasCf ? 'clear' : 'REAL'} at ${sec(t0)}s`);
    return out;
  }
}

/* ---- pick + click the best button on the page ---- */
async function pickAndClick(page, avoid) {
  let picked = null;
  try {
    picked = await withTimeout(page.evaluate((avoidName) => {
      const nm = s => (s == null ? '' : String(s))
        .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

      const score = el => {
        const txt = nm(el.innerText || el.value || '');
        const hay = txt + ' ' + nm(el.id) + ' ' + nm(el.className) + ' ' + nm(el.getAttribute('name'));
        let s = 0;
        if (hay.includes("i'm a human") || hay.includes('im a human')) s += 120;
        if (hay.includes('get link')) s += 110;
        if (hay.includes('btn-main') || hay.includes('btnmain')) s += 105;
        if (hay.includes('continue')) s += 70;
        if (hay.includes('proceed')) s += 65;
        if (hay.includes('skip')) s += 55;
        if (hay.includes('click here')) s += 45;
        if (hay.includes('start earning')) s += 15;
        if (hay.includes('login') || hay.includes('signup')) s -= 20;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 5 || r.height < 5) s -= 60;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') s -= 60;
        if (avoidName && txt === avoidName) s -= 150;
        return s;
      };

      const all = Array.from(document.querySelectorAll(
        'button, a[href], input[type=submit], input[type=button], [role=button], [onclick]'
      ));

      let best = null, bs = -Infinity;
      for (const el of all) { const s = score(el); if (s > bs) { bs = s; best = el; } }

      if (!best) {
        for (const el of document.querySelectorAll('*')) {
          if (el.children.length > 2) continue;
          const t = nm(el.innerText || '');
          if (t === "i'm a human" || t === 'get link' || t === 'continue' || t === 'proceed') { best = el; break; }
        }
      }
      if (!best) return null;

      document.querySelectorAll('[data-bot]').forEach(e => e.removeAttribute('data-bot'));
      best.setAttribute('data-bot', '1');
      try { best.scrollIntoView({ block: 'center' }); } catch (_) {}
      return { name: (best.innerText || best.value || best.id || 'btn').trim().slice(0, 32) };
    }, avoid || null), EVAL_MS, 'pick');
  } catch (_) { return null; }

  if (!picked) return null;

  try {
    await withTimeout(page.click('[data-bot]', { timeout: CLICK_MS }), CLICK_MS + 2500, 'click');
  } catch (_) {
    try {
      await withTimeout(page.evaluate(() => {
        const el = document.querySelector('[data-bot]');
        if (el) el.click();
      }), 4000, 'jsclick');
    } catch (_) {}
  }
  return picked.name;
}

/* ---- one page journey ---- */
async function visitOnce(page, url, log) {
  const r = { ok: false, cf: false, hops: 0, cleared: false, clicks: 0, done: false, note: '', dbg: null };

  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
    r.ok = true;
  } catch (e) {
    r.note = shortErr(e);
    r.dbg = await snapshot(page);
    return r;
  }

  let avoid = null;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const cf = await passCf(page, url, log);
    if (cf.wasCf) r.cf = true;
    if (cf.cleared) r.cleared = true;
    if (cf.stuck) { r.note = 'cf never cleared'; r.dbg = await snapshot(page); return r; }

    const snap = await snapshot(page);
    r.dbg = snap;
    if (!snap) { r.note = 'blank page'; return r; }

    if (isDest(snap.host)) {
      await sleep(1200);
      r.done = true;
      r.note = 'reached destination';
      return r;
    }

    if (hop === MAX_HOPS) { r.note = 'max hops'; return r; }

    const urlBefore = page.url();
    const name = await pickAndClick(page, avoid);
    if (!name) {
      await sleep(900);
      const s2 = await snapshot(page);
      if (s2 && isDest(s2.host)) { r.done = true; r.note = 'reached destination'; }
      else r.note = 'no clickable button';
      return r;
    }

    r.clicks++;
    r.hops++;
    log(`${IND}[hop${hop + 1}] clicked=${name} url=${page.url().slice(0, 80)}`);

    await sleep(HOP_WAIT_MS);

    const urlAfter = page.url();
    if (name === avoid && urlAfter === urlBefore) r.note = 'clicked same, no nav';
    else if (urlAfter !== urlBefore) avoid = null;
    else avoid = name;
  }
  return r;
}

/* ---- public entry: hard-capped end to end ---- */
async function attemptVisit(proxy, url, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const state = { ctx: null };
  const t0 = Date.now();

  const kill = () => {
    const c = state.ctx;
    if (c) withTimeout(c.close(), 8000, 'ctxclose').catch(() => {});
  };

  const body = (async () => {
    const browser = await B.getBrowser();
    const prof = PROFILES[Math.floor(Math.random() * PROFILES.length)];
    const ctxOpts = {
      ignoreHTTPSErrors: true,
      userAgent: prof.ua,
      locale: prof.loc,
      timezoneId: prof.tz,
      viewport: { width: 1280 + Math.floor(Math.random() * 160), height: 720 + Math.floor(Math.random() * 180) },
    };
    const pu = proxyUrl(proxy);
    if (pu) ctxOpts.proxy = { server: pu };

    const ctx = await withTimeout(browser.newContext(ctxOpts), CTX_MS, 'newContext');
    state.ctx = ctx;

    const page = await withTimeout(ctx.newPage(), 12000, 'newPage');
    page.setDefaultTimeout(CLICK_MS);
    page.setDefaultNavigationTimeout(NAV_MS);

    return await visitOnce(page, url, log);
  })();

  let res;
  try {
    res = await withTimeout(body, VISIT_BUDGET + 15000, 'attemptVisit', kill);
  } catch (e) {
    res = { ok: false, cf: false, hops: 0, cleared: false, clicks: 0, done: false, note: shortErr(e), dbg: null };
  }

  res.ms = Date.now() - t0;
  res.proxy = proxy;

  if (state.ctx) withTimeout(state.ctx.close(), 8000, 'ctxclose').catch(() => {});

  return res;
}

module.exports = { attemptVisit, passCf, snapshot, withTimeout };
