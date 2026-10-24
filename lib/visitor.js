'use strict';
/* lib/visitor.js — one visit attempt through one proxy. */

const B = require('./browser');

function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : d;
}

const NAV_MS = n(process.env.NAV_TIMEOUT_MS, 18000);
const EVAL_MS = n(process.env.EVAL_TIMEOUT_MS, 9000);
const CLICK_MS = n(process.env.CLICK_TIMEOUT_MS, 6000);
const CF_BUDGET_MS = n(process.env.CF_BUDGET_MS, 40000);
const CF_GO_BUDGET_MS = n(process.env.CF_GO_BUDGET_MS, 46000);
const CF_SETTLE_MS = n(process.env.CF_SETTLE_MS, 5000);
const CF_MAX_RELOAD = n(process.env.CF_MAX_RELOADS, 5);
const CF_GO_MAX_RELOAD = n(process.env.CF_GO_MAX_RELOADS, 2);
const CF_MAX_RESET = n(process.env.CF_MAX_RESETS, 1);
const CF_MAX_POKE = n(process.env.CF_MAX_POKES, 3);
const VISIT_BUDGET = n(process.env.VISIT_BUDGET_MS, 90000);
const MAX_HOPS = n(process.env.MAX_HOPS, 6);
const HOP_WAIT_MS = n(process.env.HOP_WAIT_MS, 2500);
const CTX_MS = n(process.env.CTX_TIMEOUT_MS, 20000);
const WAIT_BUTTON_MS = n(process.env.WAIT_BUTTON_MS, 12000);
const CTX_MAX = n(process.env.CTX_MAX, 8);
const CTX_REUSE = process.env.CTX_REUSE !== '0';
const IND = '        ';

function sleep(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

function sec(t0) {
  return Math.round((Date.now() - t0) / 1000);
}

function shortErr(e) {
  return String((e && e.message) || e || '').split('\n')[0].slice(0, 140);
}

function safeCall(fn) {
  try {
    return fn();
  } catch (e) {
    return null;
  }
}

function withTimeout(promise, ms, label, onTimeout) {
  let t = null;
  const guard = new Promise(function (_, rej) {
    t = setTimeout(function () {
      if (onTimeout) { safeCall(onTimeout); }
      rej(new Error('TIMEOUT ' + label + ' ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).then(
    function (v) { if (t) { clearTimeout(t); } return v; },
    function (e) { if (t) { clearTimeout(t); } throw e; }
  );
}

function bg(p) {
  Promise.resolve(p).then(function () {}, function () {});
}

function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PROFILES = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'en-US', 'America/New_York'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'en-GB', 'Europe/London'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'en-US', 'America/Chicago'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'en-US', 'America/Denver'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'en-US', 'America/Los_Angeles'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'en-US', 'America/New_York'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'en-CA', 'America/Toronto']
];

function proxyUrl(p) {
  const s = String(p || '').trim();
  if (!s) { return null; }
  return 'http://' + s.replace(/^[a-z0-9]+:\/\//i, '');
}

async function snapshot(page) {
  try {
    return await withTimeout(page.evaluate(function () {
      const body = document.body ? document.body.innerText : '';
      return {
        host: location.host,
        href: location.href,
        path: location.pathname,
        title: document.title || '',
        text: (body || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      };
    }), EVAL_MS, 'snapshot');
  } catch (e) {
    return null;
  }
}

const CF_WORDS = [
  'performing security verification',
  'checking if the site connection is secure',
  'verify you are human',
  'just a moment',
  'enable javascript and cookies',
  'attention required'
];

const CF_TITLES = ['just a moment', 'attention required'];

function isCf(snap) {
  if (!snap) { return false; }
  const t = norm(snap.text);
  const ti = norm(snap.title);
  for (let i = 0; i < CF_WORDS.length; i++) {
    if (t.indexOf(CF_WORDS[i]) >= 0) { return true; }
  }
  for (let i = 0; i < CF_TITLES.length; i++) {
    if (ti.indexOf(CF_TITLES[i]) >= 0) { return true; }
  }
  return false;
}

const OUO_HOSTS = ['ouo.io', 'ouo.press', 'asdfix.com', 'ouo.pw'];

function hostOf(h) {
  return String(h || '').replace(/^www\./, '').toLowerCase();
}

function isOuo(h) {
  const x = hostOf(h);
  for (let i = 0; i < OUO_HOSTS.length; i++) {
    const o = OUO_HOSTS[i];
    if (x === o || x.endsWith('.' + o)) { return true; }
  }
  return false;
}

function isDest(h) {
  const x = hostOf(h);
  return !!x && !isOuo(x);
}

function currentHost(page) {
  try {
    return hostOf(new URL(page.url()).host);
  } catch (e) {
    return '';
  }
}

function currentPath(page) {
  try {
    return new URL(page.url()).pathname;
  } catch (e) {
    return '';
  }
}

function isGoPath(page) {
  return /^\/go\//.test(currentPath(page));
}

async function tryReload(page) {
  try {
    await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'reload');
  } catch (e) {
    try {
      await withTimeout(page.evaluate('location.reload()'), 6000, 'jsreload');
    } catch (e2) {
      bg(Promise.resolve());
    }
  }
  await sleep(300);
}

async function tryGoto(page, url) {
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
  } catch (e) {
    bg(Promise.resolve());
  }
  await sleep(300);
}

async function reloadAndSettle(page) {
  await tryReload(page);
  const t = Date.now();
  while (Date.now() - t < CF_SETTLE_MS) {
    await sleep(700);
    const s = await snapshot(page);
    if (s && s.text && s.text.length > 25 && !isCf(s)) { return; }
  }
}

/* click the turnstile checkbox by walking real frames */
async function pokeCf(page, log) {
  try {
    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      let u = '';
      try {
        u = (f.url && f.url()) || '';
      } catch (e) {
        u = '';
      }
      if (!/challenges\.cloudflare\.com|turnstile|cdn-cgi\/challenge/.test(u)) { continue; }
      const box = await withTimeout(f.locator('body').first().boundingBox(), 3000, 'cfbox');
      if (!box || box.width < 6 || box.height < 6) { continue; }
      const x = box.x + Math.min(22, box.width / 3);
      const y = box.y + box.height / 2;
      await withTimeout(page.mouse.click(x, y), 4000, 'cfpoke');
      log(IND + '[cf] poked turnstile');
      return true;
    }
    log(IND + '[cf] no turnstile frame');
    return false;
  } catch (e) {
    return false;
  }
}

async function passCf(page, home, log, opts) {
  const goMode = !!(opts && opts.goMode);
  const budget = goMode ? CF_GO_BUDGET_MS : CF_BUDGET_MS;
  const maxReload = goMode ? CF_GO_MAX_RELOAD : CF_MAX_RELOAD;
  const blankLimit = goMode ? 15000 : 9000;

  const out = { cleared: false, wasCf: false, stuck: false };
  const t0 = Date.now();
  let reloads = 0;
  let resets = 0;
  let pokes = 0;
  let blankSince = Date.now();

  await sleep(goMode ? 2500 : 900);

  for (;;) {
    if (Date.now() - t0 > budget) {
      out.stuck = true;
      return out;
    }

    const snap = await snapshot(page);
    const len = snap && snap.text ? snap.text.length : 0;

    if (len < 25) {
      if (Date.now() - blankSince > blankLimit) {
        out.cleared = true;
        log(IND + '[cf] blank-clear at ' + sec(t0) + 's');
        return out;
      }
      await sleep(700);
      continue;
    }
    blankSince = Date.now();

    if (isCf(snap)) {
      out.wasCf = true;

      if (pokes < CF_MAX_POKE && sec(t0) > 2) {
        pokes++;
        const ok = await pokeCf(page, log);
        if (ok) {
          await sleep(goMode ? 6000 : 3000);
          continue;
        }
      }

      if (reloads < maxReload) {
        reloads++;
        log(IND + '[cf] stall-reload ' + reloads + ' at ' + sec(t0) + 's');
        await reloadAndSettle(page);
        continue;
      }

      if (resets < CF_MAX_RESET && !goMode) {
        resets++;
        reloads = 0;
        log(IND + '[cf] hard-reset ' + resets + ' at ' + sec(t0) + 's');
        await tryGoto(page, home);
        await sleep(1500);
        continue;
      }

      await sleep(1500);
      continue;
    }

    out.cleared = true;
    log(IND + '[cf] ' + (out.wasCf ? 'clear' : 'REAL') + ' at ' + sec(t0) + 's');
    return out;
  }
}

async function scan(page) {
  try {
    return await withTimeout(page.evaluate(function () {
      function nm(s) {
        return String(s == null ? '' : s)
          .replace(/[\u2018\u2019\u02bc]/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }

      function safe(fn, dflt) {
        try {
          return fn();
        } catch (e) {
          return dflt;
        }
      }

      const SKIP = {
        SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, PATH: 1,
        BR: 1, HR: 1, META: 1, LINK: 1, TITLE: 1
      };

      function collect(maxKids) {
        const out = [];
        const nodes = document.querySelectorAll('body *');
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          if (SKIP[el.tagName]) { continue; }
          if (el.children.length > maxKids) { continue; }

          const raw = el.innerText || el.value || '';
          const txt = nm(raw);
          if (!txt || txt.length > 60) { continue; }

          const tag = el.tagName.toLowerCase();
          const href = ((el.getAttribute && el.getAttribute('href')) || '').toLowerCase();
          const hay = txt + ' ' + nm(el.id) + ' ' + nm(el.className) + ' ' + nm(el.getAttribute('name'));
          let s = 0;

          if (/i'?m a human|im a human/.test(hay)) { s += 200; }
          if (/get\s*link/.test(hay)) { s += 190; }
          if (/btn-?main/.test(hay)) { s += 180; }
          if (/continue|proceed/.test(hay)) { s += 90; }
          if (/skip/.test(hay)) { s += 70; }
          if (/click here/.test(hay)) { s += 55; }
          if (tag === 'a' || tag === 'button' || tag === 'input') { s += 30; }

          if (/^(cloudflare|privacy|performance and security|ray id|support)/.test(txt)) { s -= 150; }
          if (/^ouo\.(io|press)$/.test(txt)) { s -= 110; }
          if (/(^|\/)(rates|faq|blog|terms|privacy|contact|about|login|signup|auth|how|dmca|abuse|api)(\/|$|\?)/.test(href)) { s -= 130; }
          if (href === 'https://ouo.io/' || href === 'https://ouo.press/' || href === '/' || href === '') { s -= 120; }
          if (/payout|start earning|register now|learn more|features|shorten now/.test(txt)) { s -= 60; }

          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) { s -= 200; }
          if (r.width > 90 && r.height > 28) { s += 25; }

          const cs = safe(function () { return getComputedStyle(el); }, null);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) { s -= 200; }

          out.push({ el: el, s: s, name: String(raw).replace(/\s+/g, ' ').trim().slice(0, 30) });
        }
        out.sort(function (a, b) { return b.s - a.s; });
        return out;
      }

      let scored = collect(4);
      if (!scored.length || scored[0].s < 0) {
        const wide = collect(80);
        if (wide.length && (!scored.length || wide[0].s > scored[0].s)) { scored = wide; }
      }
      if (!scored.length) { return null; }

      const best = scored[0];
      const olds = document.querySelectorAll('[data-bot]');
      for (let i = 0; i < olds.length; i++) { olds[i].removeAttribute('data-bot'); }
      safe(function () { best.el.scrollIntoView({ block: 'center' }); }, null);
      best.el.setAttribute('data-bot', '1');

      const rr = best.el.getBoundingClientRect();
      const top = [];
      for (let i = 0; i < scored.length && i < 5; i++) {
        top.push(scored[i].name + '(' + scored[i].s + ')');
      }

      return {
        name: best.name,
        score: best.s,
        top: top.join(' | '),
        x: Math.round(rr.left + rr.width / 2),
        y: Math.round(rr.top + rr.height / 2)
      };
    }), EVAL_MS, 'scan');
  } catch (e) {
    return null;
  }
}

async function clickTagged(page, info) {
  try {
    await withTimeout(page.click('[data-bot]', { timeout: 4500 }), 6500, 'click');
    return true;
  } catch (e) {
    bg(Promise.resolve());
  }

  try {
    await withTimeout(page.mouse.click(info.x, info.y), 5000, 'mouseclick');
    return true;
  } catch (e) {
    bg(Promise.resolve());
  }

  try {
    await withTimeout(page.evaluate(function () {
      const el = document.querySelector('[data-bot]');
      if (el) { el.click(); }
    }), 5000, 'jsclick');
    return true;
  } catch (e) {
    bg(Promise.resolve());
  }

  return false;
}

async function waitAndPick(page, log, opts) {
  const deadline = Date.now() + (opts.waitMs || 0);
  const minScore = opts.minScore || 0;
  let best = null;

  for (;;) {
    const s = await scan(page);
    if (s && (!best || s.score > best.score)) { best = s; }
    if (best && best.score >= minScore) { break; }
    if (Date.now() >= deadline) { break; }
    await sleep(700);
  }

  if (!best) {
    log(IND + '[pick] none found');
    return null;
  }

  log(IND + '[pick] best="' + best.name + '" score=' + best.score + ' :: ' + best.top);
  const ok = await clickTagged(page, best);
  if (!ok) { log(IND + '[pick] click FAILED'); }
  return ok ? best : null;
}

async function visitOnce(page, url, log) {
  const r = {
    ok: false, cf: false, hops: 0, cleared: false,
    clicks: 0, paid: false, done: false, note: '', dbg: null
  };
  const t0 = Date.now();

  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
    r.ok = true;
  } catch (e) {
    r.note = shortErr(e);
    r.dbg = await snapshot(page);
    return r;
  }

  let avoid = null;
  let recover = 0;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const cf = await passCf(page, url, log, { goMode: isGoPath(page) });
    if (cf.wasCf) { r.cf = true; }
    if (cf.cleared) { r.cleared = true; }
    if (cf.stuck) {
      r.note = 'cf never cleared';
      r.dbg = await snapshot(page);
      r.done = r.paid;
      return r;
    }

    let snap = await snapshot(page);

    /* still CF, or an empty frame -> one more full pass */
    if (isCf(snap) || !snap || (snap.text || '').length < 40) {
      const cf2 = await passCf(page, url, log, { goMode: isGoPath(page) });
      if (cf2.wasCf) { r.cf = true; }
      if (cf2.cleared) { r.cleared = true; }
      if (cf2.stuck) {
        r.note = 'cf never cleared (2)';
        r.dbg = await snapshot(page);
        r.done = r.paid;
        return r;
      }
      snap = await snapshot(page);
    }

    if (cf.wasCf) { await sleep(1200); }

    if (isDest(currentHost(page))) {
      await sleep(1400);
      r.done = true;
      r.note = 'reached destination';
      r.dbg = await snapshot(page);
      return r;
    }

    r.dbg = snap;
    if (!snap) {
      r.note = 'blank page';
      r.done = r.paid;
      return r;
    }

    const pth = currentPath(page);
    if (hop >= 1 && isOuo(currentHost(page)) && (pth === '/' || pth === '')) {
      if (!r.paid && recover < 1 && (Date.now() - t0) < 50000) {
        recover++;
        log(IND + '[rec] lost flow -> restart from short link');
        await tryGoto(page, url);
        await sleep(800);
        continue;
      }
      r.note = r.paid ? 'clicked get link' : 'ouo landing';
      r.done = r.paid;
      return r;
    }

    if (hop === MAX_HOPS) {
      r.note = 'max hops';
      r.done = r.paid;
      return r;
    }

    const urlBefore = page.url();
    const picked = await waitAndPick(page, log, { waitMs: WAIT_BUTTON_MS, minScore: 40 });

    if (isDest(currentHost(page))) {
      await sleep(1200);
      r.done = true;
      r.note = 'reached destination';
      return r;
    }

    if (!picked) {
      await sleep(900);
      if (isDest(currentHost(page))) {
        r.done = true;
        r.note = 'reached destination';
      } else {
        r.note = 'no clickable button';
        r.done = r.paid;
      }
      return r;
    }

    if (/get\s*link/i.test(picked.name)) { r.paid = true; }

    r.clicks++;
    r.hops++;
    log(IND + '[hop' + (hop + 1) + '] clicked="' + picked.name + '"' + (r.paid ? ' PAID' : '') + ' url=' + page.url().slice(0, 70));

    await sleep(HOP_WAIT_MS);

    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
      avoid = null;
    } else if (picked.name === avoid) {
      r.note = 'clicked same, no nav';
      r.done = r.paid;
      return r;
    } else {
      avoid = picked.name;
    }
  }

  r.done = r.paid;
  return r;
}

const ctxCache = new Map();

async function newCtx(browser, proxy) {
  const p = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  const o = {
    ignoreHTTPSErrors: true,
    userAgent: p[0],
    locale: p[1],
    timezoneId: p[2],
    viewport: {
      width: 1280 + Math.floor(Math.random() * 160),
      height: 720 + Math.floor(Math.random() * 180)
    }
  };
  const pu = proxyUrl(proxy);
  if (pu) { o.proxy = { server: pu }; }
  return await withTimeout(browser.newContext(o), CTX_MS, 'newContext');
}

function evictCtx() {
  if (ctxCache.size <= CTX_MAX) { return; }
  const entries = [];
  ctxCache.forEach(function (v, k) { entries.push([k, v]); });
  entries.sort(function (a, b) { return a[1].ts - b[1].ts; });
  while (ctxCache.size > CTX_MAX && entries.length) {
    const kv = entries.shift();
    ctxCache.delete(kv[0]);
    bg(withTimeout(kv[1].ctx.close(), 8000, 'ctxclose'));
  }
}

async function getCtx(browser, proxy) {
  if (!CTX_REUSE) { return await newCtx(browser, proxy); }
  const key = proxy || '__direct__';
  const hit = ctxCache.get(key);
  if (hit) {
    try {
      const pages = await withTimeout(hit.ctx.pages(), 3000, 'pages');
      if (pages) {
        hit.ts = Date.now();
        return hit.ctx;
      }
    } catch (e) {
      bg(Promise.resolve());
    }
    ctxCache.delete(key);
  }
  const ctx = await newCtx(browser, proxy);
  ctxCache.set(key, { ctx: ctx, ts: Date.now() });
  evictCtx();
  return ctx;
}

function dropCtx(proxy) {
  const key = proxy || '__direct__';
  const hit = ctxCache.get(key);
  if (!hit) { return; }
  ctxCache.delete(key);
  bg(withTimeout(hit.ctx.close(), 8000, 'ctxclose'));
}

async function attemptVisit(proxy, url, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const state = { page: null };
  const t0 = Date.now();

  const kill = function () {
    if (state.page) { bg(withTimeout(state.page.close(), 6000, 'pageclose')); }
  };

  const body = (async function () {
    const browser = await B.getBrowser();
    const ctx = await withTimeout(getCtx(browser, proxy), CTX_MS + 5000, 'ctx');
    const page = await withTimeout(ctx.newPage(), 12000, 'newPage');
    state.page = page;
    page.setDefaultTimeout(CLICK_MS);
    page.setDefaultNavigationTimeout(NAV_MS);
    try {
      return await visitOnce(page, url, log);
    } finally {
      bg(withTimeout(page.close(), 6000, 'pageclose'));
    }
  })();

  let res;
  try {
    res = await withTimeout(body, VISIT_BUDGET + 12000, 'attemptVisit', kill);
  } catch (e) {
    res = {
      ok: false, cf: false, hops: 0, cleared: false,
      clicks: 0, paid: false, done: false, note: shortErr(e), dbg: null
    };
  }

  res.ms = Date.now() - t0;
  res.proxy = proxy;

  if (!res.ok || !res.cleared) { dropCtx(proxy); }

  return res;
}

module.exports = { attemptVisit: attemptVisit, passCf: passCf, snapshot: snapshot, withTimeout: withTimeout };
