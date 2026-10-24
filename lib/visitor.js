'use strict';
/* lib/visitor.js
 * One visit attempt through one proxy.
 *  - every Playwright call is hard-capped
 *  - CF reloads are paced so the challenge can actually solve
 *  - on ouo pages we WAIT for a high-confidence button instead of
 *    clicking whatever half-rendered element is on screen */

const B = require('./browser');

const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

const NAV_MS        = n(process.env.NAV_TIMEOUT_MS, 20000);
const EVAL_MS       = n(process.env.EVAL_TIMEOUT_MS, 7000);
const CLICK_MS      = n(process.env.CLICK_TIMEOUT_MS, 6000);
const CF_BUDGET_MS  = n(process.env.CF_BUDGET_MS, 42000);
const CF_SETTLE_MS  = n(process.env.CF_SETTLE_MS, 3500);
const CF_MAX_RELOAD = n(process.env.CF_MAX_RELOADS, 5);
const CF_MAX_RESET  = n(process.env.CF_MAX_RESETS, 1);
const VISIT_BUDGET  = n(process.env.VISIT_BUDGET_MS, 95000);
const MAX_HOPS      = n(process.env.MAX_HOPS, 8);
const HOP_WAIT_MS   = n(process.env.HOP_WAIT_MS, 2500);
const CTX_MS        = n(process.env.CTX_TIMEOUT_MS, 20000);
const WAIT_BTN_MS   = n(process.env.WAIT_BUTTON_MS, 9000);
const IND           = '        ';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sec = t0 => Math.round((Date.now() - t0) / 1000);
const shortErr = e => String((e && e.message) || e || '').split('\n')[0].slice(0, 140);

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
  return 'http://' + s.replace(/^[a-z0-9]+:\/\//i, '');
}

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
function currentHost(page) { try { return hostOf(new URL(page.url()).host); } catch (_) { return ''; } }
function currentPath(page) { try { return new URL(page.url()).pathname; } catch (_) { return ''; } }

async function tryReload(page) {
  try {
    await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'reload');
  } catch (_) { try { page.evaluate(() => location.reload()); } catch (_) {} }
  await sleep(300);
}

async function tryGoto(page, url) {
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
  } catch (_) {}
  await sleep(300);
}

/* paced reload: reload, then poll — return the moment CF is gone */
async function reloadAndSettle(page) {
  await tryReload(page);
  const t = Date.now();
  while (Date.now() - t < CF_SETTLE_MS) {
    await sleep(700);
    const s = await snapshot(page);
    if (s && s.text && s.text.length > 25 && !isCf(s)) return;
  }
}

async function passCf(page, home, log) {
  const out = { cleared: false, wasCf: false, stuck: false };
  const t0 = Date.now();
  let reloads = 0, resets = 0, blankSince = Date.now();

  await sleep(500);

  for (;;) {
    if (Date.now() - t0 > CF_BUDGET_MS) { out.stuck = true; return out; }

    const snap = await snapshot(page);
    const len = snap && snap.text ? snap.text.length : 0;

    if (len < 25) {
      if (Date.now() - blankSince > 8000) {
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
        await reloadAndSettle(page);
        continue;
      }
      if (resets < CF_MAX_RESET) {
        resets++; reloads = 0;
        log(`${IND}[cf] hard-reset ${resets} at ${sec(t0)}s`);
        await tryGoto(page, home);
        await sleep(1200);
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

/* ---------------- button scoring ---------------- */
const BAD_HREF = /(\/rates|\/auth\/|\/login|\/signup|\/faq|\/blog|\/terms|\/privacy|\/contact|\/about|\/how)/;
const BAD_TEXT = /(start earning|register|payout|faq|login|sign up|signup|terms|privacy|contact|about us)/;

/* find (and tag) the best button, without clicking */
async function findButton(page, avoid) {
  try {
    return await withTimeout(page.evaluate((avoidName) => {
      const nm = s => (s == null ? '' : String(s))
        .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

      const score = el => {
        const txt = nm(el.innerText || el.value || '');
        const hay = txt + ' ' + nm(el.id) + ' ' + nm(el.className) + ' ' + nm(el.getAttribute('name'));
        let s = 0;
        if (hay.includes('get link')) s += 130;
        if (hay.includes("i'm a human") || hay.includes('im a human')) s += 125;
        if (hay.includes('btn-main') || hay.includes('btnmain')) s += 115;
        if (hay.includes('continue')) s += 60;
        if (hay.includes('proceed')) s += 55;
        if (hay.includes('skip')) s += 50;
        if (hay.includes('click here')) s += 40;

        const href = ((el.getAttribute && el.getAttribute('href')) || '').toLowerCase();
        if (href && BAD_HREF.test(href)) s -= 90;
        if (href === 'https://ouo.io/' || href === '/') s -= 70;
        if (txt && BAD_TEXT.test(txt)) s -= 60;

        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 5 || r.height < 5) s -= 60;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') s -= 60;
        if (r.width > 120 && r.height > 30) s += 10;
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
          if (t === "i'm a human" || t === 'get link' || t === 'continue' || t === 'proceed') { best = el; bs = 110; break; }
        }
      }
      if (!best) return null;

      document.querySelectorAll('[data-bot]').forEach(e => e.removeAttribute('data-bot'));
      best.setAttribute('data-bot', '1');
      try { best.scrollIntoView({ block: 'center' }); } catch (_) {}
      return { name: (best.innerText || best.value || best.id || 'btn').trim().slice(0, 32), score: bs };
    }, avoid || null), EVAL_MS, 'pick');
  } catch (_) { return null; }
}

/* wait for a high-confidence button, then click it */
async function pickAndClick(page, avoid, opts) {
  opts = opts || {};
  const minScore = opts.minScore || 0;
  const waitMs = opts.waitMs || 0;
  const deadline = Date.now() + waitMs;

  let picked = await findButton(page, avoid);

  while ((!picked || picked.score < minScore) && Date.now() < deadline) {
    await sleep(800);
    if (isDest(currentHost(page))) return null;      // page redirected under us
    const again = await findButton(page, avoid);
    if (again && (!picked || again.score > picked.score)) picked = again;
    if (picked && picked.score >= minScore) break;
  }

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

    if (cf.wasCf) await sleep(1500);   // let the countdown page start rendering

    if (isDest(currentHost(page))) {
      await sleep(1200);
      r.done = true; r.note = 'reached destination';
      r.dbg = await snapshot(page);
      return r;
    }

    const snap = await snapshot(page);
    r.dbg = snap;
    if (!snap) { r.note = 'blank page'; return r; }
    if (hop === MAX_HOPS) { r.note = 'max hops'; return r; }

    const onOuo = isOuo(currentHost(page));
    const onGo = /^\/go\//.test(currentPath(page));

    const urlBefore = page.url();
    const name = await pickAndClick(page, avoid, {
      minScore: onOuo ? 100 : 0,
      waitMs: onOuo ? (onGo ? WAIT_BTN_MS + 4000 : WAIT_BTN_MS) : 0,
    });

    if (isDest(currentHost(page))) {
      await sleep(1000);
      r.done = true; r.note = 'reached destination';
      return r;
    }

    if (!name) {
      await sleep(900);
      if (isDest(currentHost(page))) { r.done = true; r.note = 'reached destination'; }
      else r.note = 'no clickable button';
      return r;
    }

    r.clicks++;
    r.hops++;
    log(`${IND}[hop${hop + 1}] clicked=${name} url=${page.url().slice(0, 80)}`);

    await sleep(HOP_WAIT_MS);

    const urlAfter = page.url();
    if (urlAfter
