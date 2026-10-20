'use strict';

const fs = require('fs');
const path = require('path');
const { getProxies, validateProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const { closeBrowser } = require('../lib/browser');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const STATS = path.join(DATA, 'stats.json');
const CSV = path.join(DATA, 'history.csv');
const LINKS = path.join(ROOT, 'links.json');

const DURATION_MIN = Number(process.env.DURATION_MINUTES || 180);
const TARGET_VIEWS = Number(process.env.TARGET_VIEWS || 0);
const MIN_GAP = Number(process.env.MIN_GAP_SECONDS || 20);
const MAX_GAP = Number(process.env.MAX_GAP_SECONDS || 70);
const BREAK_EVERY = Number(process.env.BREAK_EVERY || 25);
const BREAK_SECONDS = Number(process.env.BREAK_SECONDS || 180);

const POOL_MIN = 20;
const POOL_TARGET = 250;
const MAX_TRIES_PER_VISIT = 4;
const VISIT_BUDGET_MS = 60000;

// Refill pacing. A 1000-proxy health check costs ~7s of CPU; running it on every
// attempt (the old behaviour) meant the bot spent most of the run validating.
const REFILL_MIN_GAP_MS = 20 * 1000;
const REFILL_BACKOFF_MAX_MS = 5 * 60 * 1000;

fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function loadStats() {
  try {
    const s = JSON.parse(fs.readFileSync(STATS, 'utf8'));
    s.lifetimeViews = Number(s.lifetimeViews) || 0;
    s.lifetimeAttempts = Number(s.lifetimeAttempts) || 0;
    if (!Array.isArray(s.runs)) s.runs = [];
    if (!s.firstRun) s.firstRun = new Date().toISOString();
    return s;
  } catch {
    return {
      lifetimeViews: 0,
      lifetimeAttempts: 0,
      firstRun: new Date().toISOString(),
      runs: [],
    };
  }
}
const saveStats = (s) => fs.writeFileSync(STATS, JSON.stringify(s, null, 2));

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function appendCsv(cells) {
  if (!fs.existsSync(CSV)) {
    fs.writeFileSync(CSV, 'timestamp,link,success,proxy,final,elapsed_ms,note\n');
  }
  fs.appendFileSync(CSV, cells.map(csvCell).join(',') + '\n');
}

function loadLinks() {
  try {
    const j = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
    return (j.links || []).map((s) => String(s).trim()).filter(Boolean);
  } catch { return []; }
}

let pool = [];
let good = [];              // proxies that have produced a completed visit
const proxyStats = new Map(); // proxy -> { ok, fail }
let stats = null;
let run = null;
let finishing = false;

let lastRefillAt = 0;
let refillFailures = 0;

async function refillPool(force = false) {
  if (!force && pool.length >= POOL_MIN) return;

  if (!force) {
    const gap = refillFailures
      ? Math.min(REFILL_BACKOFF_MAX_MS, REFILL_MIN_GAP_MS * 2 ** refillFailures)
      : REFILL_MIN_GAP_MS;
    if (Date.now() - lastRefillAt < gap) return;
  }

  lastRefillAt = Date.now();
  console.log('[pool] fetching all sources...');

  const raw = await getProxies({ force: true }).catch(() => []);
  console.log(`[pool] ${raw.length} candidates, health-checking ${Math.min(raw.length, 1000)}...`);

  const sample = shuffle(raw).slice(0, 1000);
  const live = await validateProxies(sample, 150).catch(() => []);

  pool = shuffle(live).slice(0, POOL_TARGET);
  refillFailures = live.length ? 0 : refillFailures + 1;

  console.log(`[pool] ${live.length} live, holding ${pool.length} (${good.length} proven)`);
}

function recordProxy(proxy, ok) {
  if (!proxy) return;
  const s = proxyStats.get(proxy) || { ok: 0, fail: 0 };
  if (ok) {
    s.ok++;
    s.fail = 0;
    if (!good.includes(proxy)) good.unshift(proxy);
    good = good.slice(0, 50);
  } else {
    s.fail++;
    if (s.fail >= 2) good = good.filter((p) => p !== proxy);
  }
  proxyStats.set(proxy, s);
}

/**
 * Prefer a proxy that already completed a visit, then an untried one.
 * Free proxies are ~1% live, so a proven exit node is worth far more than
 * another random draw.
 */
function takeProxy() {
  while (good.length) {
    const p = good.pop();
    const s = proxyStats.get(p);
    if (s && s.fail >= 2) continue;
    return p;
  }
  return pool.length ? pool.pop() : null;
}

function finalize(exitCode) {
  if (finishing) return;
  finishing = true;

  try {
    if (stats && run) {
      run.finished = new Date().toISOString();
      run.poolAtEnd = pool.length;
      run.provenProxies = good.length;
      saveStats(stats);
      console.log(`\n=== STOPPED === views ${run.views} / attempts ${run.attempts} | lifetime ${stats.lifetimeViews}`);
    }
  } catch (e) {
    console.error('[run] failed to save stats', e.message);
  }

  closeBrowser()
    .catch(() => {})
    .finally(() => process.exit(exitCode));
}

// GitHub Actions cancels long jobs with SIGTERM. Without this the browser is
// never closed and the final run metadata is never written.
process.on('SIGTERM', () => finalize(0));
process.on('SIGINT', () => finalize(0));

async function main() {
  const links = loadLinks();
  if (!links.length) {
    console.error('links.json is empty - add your ouo links');
    process.exit(1);
  }

  stats = loadStats();
  run = {
    started: new Date().toISOString(),
    durationMinutes: DURATION_MIN,
    views: 0,
    attempts: 0,
    links: links.length,
  };
  stats.runs.unshift(run);
  stats.runs = stats.runs.slice(0, 200);

  const deadline = Date.now() + DURATION_MIN * 60 * 1000;
  let sinceBreak = 0;
  let visits = 0;

  console.log(`[run] ${links.length} links | ${DURATION_MIN} min | gap ${MIN_GAP}-${MAX_GAP}s | break every ${BREAK_EVERY}`);

  await refillPool(true);

  while (Date.now() < deadline) {
    if (TARGET_VIEWS && run.views >= TARGET_VIEWS) {
      console.log('[run] target reached');
      break;
    }

    // Rotate on visits, not on attempts: attempts advance up to 4x per visit and
    // made the link distribution uneven.
    const link = links[visits % links.length];
    visits++;

    let ok = false, usedProxy = null, finalUrl = null, note = '';
    const t0 = Date.now();

    for (let t = 0; t < MAX_TRIES_PER_VISIT; t++) {
      if (Date.now() > deadline) break;
      if (pool.length < POOL_MIN) await refillPool();

      const proxy = takeProxy();
      const r = await attemptVisit(link, proxy, VISIT_BUDGET_MS);
      run.attempts++;
      stats.lifetimeAttempts++;
      recordProxy(proxy, r.completed);

      if (r.completed) {
        ok = true;
        usedProxy = proxy;
        finalUrl = r.final;
        break;
      }
      note = r.note || '';
    }

    const elapsed = Date.now() - t0;
    if (ok) { run.views++; stats.lifetimeViews++; }

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${ok ? 'VIEW' : 'MISS'} ` +
      `link=${link.slice(-8)} proxy=${usedProxy || 'direct'} ` +
      `run=${run.views}/${run.attempts} life=${stats.lifetimeViews} ${elapsed}ms` +
      (ok ? '' : ` (${note || 'no view'})`)
    );

    appendCsv([
      new Date().toISOString(), link, ok ? 1 : 0,
      usedProxy || 'direct', finalUrl || '', elapsed, note || '',
    ]);
    saveStats(stats);
    sinceBreak++;

    if (sinceBreak >= BREAK_EVERY) {
      sinceBreak = 0;
      console.log(`[run] long break ${BREAK_SECONDS}s`);
      await sleep(Math.min(BREAK_SECONDS * 1000, Math.max(0, deadline - Date.now())));
    } else {
      await sleep(Math.min(rint(MIN_GAP, MAX_GAP) * 1000, Math.max(0, deadline - Date.now())));
    }
  }

  run.finished = new Date().toISOString();
  run.poolAtEnd = pool.length;
  run.provenProxies = good.length;
  saveStats(stats);
  await closeBrowser();

  const est = ((run.views / 1000) * 1.5).toFixed(4);
  console.log(`\n=== DONE === views ${run.views} / attempts ${run.attempts} | est $${est} | lifetime ${stats.lifetimeViews}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    if (stats && run) {
      try {
        run.finished = new Date().toISOString();
        run.poolAtEnd = pool.length;
        run.error = String((e && e.message) || e).slice(0, 200);
        saveStats(stats);
      } catch { /* ignore */ }
    }
    closeBrowser().catch(() => {}).finally(() => process.exit(1));
  });
