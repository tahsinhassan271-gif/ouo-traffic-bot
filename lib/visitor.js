'use strict';
/* lib/visitor.js
 *  - all Playwright promises awaited AND caught
 *  - scanner scores every element; nav/footer chrome penalised hard
 *  - CF: pokes the Turnstile widget, then paced reloads
 *  - once GET LINK is clicked the view counts (that is ouo's paying step)
 *  - ouo landing page (path "/") is a terminal state, not another hop */

const B = require('./browser');

const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

const NAV_MS         = n(process.env.NAV_TIMEOUT_MS, 18000);
const EVAL_MS        = n(process.env.EVAL_TIMEOUT_MS, 9000);
const CLICK_MS       = n(process.env.CLICK_TIMEOUT_MS, 6000);
const CF_BUDGET_MS   = n(process.env.CF_BUDGET_MS, 40000);
const CF_SETTLE_MS   = n(process.env.CF_SETTLE_MS, 5000);
const CF_MAX_RELOAD  = n(process.env.CF_MAX_RELOADS, 5);
const CF_MAX_RESET   = n(process.env.CF_MAX_RESETS, 1);
const CF_MAX_POKE    = n(process.env.CF_MAX_POKES, 2);
const VISIT_BUDGET   = n(process.env.VISIT_BUDGET_MS, 80000);
const MAX_HOPS       = n(process.env.MAX_HOPS, 6);
const HOP_WAIT_MS    = n(process.env.HOP_WAIT_MS, 2500);
const CTX_MS         = n(process.env.CTX_TIMEOUT_MS, 20000);
const WAIT_BUTTON_MS = n(process.env.WAIT_BUTTON_MS, 12000);
const CTX_MAX        = n(process.env.CTX_MAX, 8);
const CTX_REUSE      = process.env.CTX_REUSE !== '0';
const IND            = '        ';

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
function bg(p) { try { Promise.resolve(p).catch(() => {}); } catch (_) {} }

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
  const s = String(p || '').trim();
  if (!s) return null;
  return 'http://' + s.replace(/^[a-z0-9]+:\/\//i, '');
}

async function snapshot(page) {
  try {
    return await withTimeout(page.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      return {
        host: location.host,
        href: location.href,
        path: location.pathname,
        title: document.title || '',
        text: (body || '').replace(/\s+/g, ' ').trim().slice(0, 400),
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
  } catch (_) {
    try { await withTimeout(page.evaluate('location.reload()'), 6000, 'jsreload'); } catch (_) {}
  }
  await sleep(300);
}

async function tryGoto(page, url) {
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }), NAV_MS + 4000, 'goto');
  } catch (_) {}
  await sleep(300);
}

async function reloadAndSettle(page) {
  await tryReload(page);
  const t = Date.now();
  while (Date.now() - t < CF_SETTLE_MS) {
    await sleep(700);
    const s = await snapshot(page);
    if (s && s.text && s.text.length > 25 && !isCf(s)) return;
  }
}

/* click the Turnstile checkbox itself, not the page chrome */
async function pokeCf(page, log) {
  try {
    const loc = page.locator(
      'iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i], #cf-chl-widget, .cf-turnstile'
    ).first();
    const box = await withTimeout(loc.boundingBox(), 3500, 'cfbox');
    if (!box || box.width < 8 || box.height < 8) return false;
    const x = box.x + Math.min(24, box.width / 4);
    const y = box.y + box.height / 2;
    await withTimeout(page.mouse.click(x, y), 4000, 'cfpoke');
    log(`${IND}[cf] poked turnstile`);
    return true;
  } catch (_) { return false; }
}

async function passCf(page, home, log) {
  const out = { cleared: false, wasCf: false, stuck: false };
  const t0 = Date.now();
  let reloads = 0, resets = 0, pokes = 0, blankSince = Date.now();

  await sleep(900);   // give a challenge a chance to solve on its own

  for (;;) {
    if (Date.now() - t0 > CF_BUDGET_MS) { out.stuck = true; return out; }

    const snap = await snapshot(page);
    const len = snap && snap.text ? snap.text.length : 0;

    if (len < 25) {
      if (Date.now() - blankSince > 9000) {
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

      if (pokes < CF_MAX_POKE && sec(t0) > 3) {
        pokes++;
        if (await pokeCf(page, log)) { await sleep(2500); continue; }
      }
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
        await sleep(1500);
        continue;
      }
      await sleep(1200);
      continue;
    }

    out.cleared = true;
    log(`${IND}[cf] ${out.wasCf ? 'clear' : 'REAL'} at ${sec(t0)}s`);
    return out;
  }
}

/* ---------------- click scanner ---------------- */
async function scan(page) {
  try {
    return await withTimeout(page.evaluate(() => {
      const nm = s => (s == null ? '' : String(s))
        .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
      const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, PATH: 1, BR: 1, HR: 1, META: 1, LINK: 1, TITLE: 1 };

      function collect(maxKids) {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          if (SKIP[el.tagName]) continue;
          if (el.children.length > maxKids) continue;

          const raw = el.innerText || el.value || '';
          const txt = nm(raw);
          if (!txt || txt.length > 60) continue;

          const tag = el.tagName.toLowerCase();
          const href = ((el.getAttribute && el.getAttribute('href')) || '').toLowerCase();
          const hay = txt + ' ' + nm(el.id) + ' ' + nm(el.className) + ' ' + nm(el.getAttribute('name'));

          let s = 0;
          if (/i'?m a human|im a human|are a human/.test(hay)) s += 200;
          if (/get\s*link/.test(hay)) s += 190;
          if (/btn-?main/.test(hay)) s += 180;
          if (/continue|proceed/.test(hay)) s += 90;
          if (/skip/.test(hay)) s += 70;
          if (/click here/.test(hay)) s += 55;
          if (tag === 'a' || tag === 'button' || tag === 'input') s += 30;

          /* cloudflare interstitial footer links */
          if (/^(cloudflare|privacy|performance and security|ray id|support)/.test(txt)) s -= 150;

          /* ouo marketing chrome */
          if (/(^|\/)(rates|faq|blog|terms|privacy|contact|about|login|signup|auth|how|dmca|abuse|api)(\/|$|\?)/.test(href)) s -= 130;
          if (href === 'https://ouo.io/' || href === 'https://ouo.press/' || href === '/' || href === '') s -= 120;
          if (/payout|start earning|register now|learn more|features|shorten now|^shorten$/.test(txt)) s -= 60;

          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) s -= 200;
          if (r.width > 90 && r.height > 28) s += 25;
          let cs = null;
          try { cs = getComputedStyle(el); } catch (_) {}
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) s -= 200;

          out.push({ el, s, name: String(raw).replace(/\s+/g, ' ').trim().slice(0, 30) });
        }
        out.sort((a, b) => b.s - a.s);
        return out;
      }

      let scored = collect(4);
      if (!scored.length || scored[0].s < 0) {
        const wide = collect(80);
        if (wide.length && (!scored.length || wide[0].s > scored[0].s)) scored = wide;
      }
      if (!scored.length) return null;

      const best = scored[0];
      document.querySelectorAll('[data-bot]').forEach(e => e.removeAttribute('data-bot'));
      try { best.el.scrollIntoView({ block: 'center' }); } catch (_) {}
      best.el.setAttribute('data-bot', '1');
      const r = best.el.getBoundingClientRect();

      return {
        name: best.name,
        score: best.s,
        top: scored.slice(0, 5).map(x => `${x.name}(${x.s})`).join(' | '),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    }), EVAL_MS, 'scan');
  } catch (_) { return null; }
}

async function clickTagged(page, info) {
  try { await withTimeout(page.click('[data-bot]', { timeout: 4500 }), 6500, 'click'); return true; } catch (_) {}
  try { await withTimeout(page.mouse.click(info.x, info.y), 5000, 'mouseclick'); return true; } catch (_) {}
  try {
    await withTimeout(page.evaluate(() => {
      const e = document.querySelector('[data-bot]');
      if (e) e.click();
    }), 5000, 'jsclick');
    return true;
  } catch (_) {}
  return false;
}

async function waitAndPick(page, log, opts) {
  const deadline = Date.now() + (opts.waitMs || 0);
  const minScore = opts.minScore || 0;
  let best = null;

  for (;;) {
    const s = await scan(page);
    if (s && (!best || s.score > best.score)) best = s;
    if (best && best.score >= minScore) break;
    if (Date.now() >= deadline) break;
    await sleep(700);
  }

  if (!best) { log(`${IND}[pick] none found`); return null; }
  log(`${IND}[pick] best="${best.name}" score=${best.score} :: ${best.top}`);
  const ok = await clickTagged(page, best);
  if (!ok) log(`${IND}[pick] click FAILED`);
  return ok ? best : null;
}

/* ---------------- one page journey ---------------- */
async function visitOnce(page, url, log) {
  const r = {
    ok: false, cf: false, hops: 0, cleared: false, clicks: 0
