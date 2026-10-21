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
const MIN_GAP = Number(process.env.MIN_GAP_SECONDS || 15);
const MAX_GAP = Number(process.env.MAX_GAP_SECONDS || 50);
const BREAK_EVERY = Number(process.env.BREAK_EVERY || 30);
const BREAK_SECONDS = Number(process.env.BREAK_SECONDS || 150);

const POOL_MIN = 40;
const POOL_TARGET = 300;
const SAMPLE = 1200;
const MAX_TRIES = 5;
const VISIT_BUDGET_MS = 45000;

fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS, 'utf8')); }
  catch {
    return { lifetimeViews: 0, lifetimeAttempts: 0, firstRun: new Date().toISOString(), runs: [] };
  }
}
const saveStats = (s) => { try { fs.writeFileSync(STATS, JSON.stringify(s, null, 2)); } catch {} };

function appendCsv(row) {
  try {
    if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'timestamp,link,success,proxy,cleared,clicks,final,elapsed_ms\n');
    fs.appendFileSync(CSV, row + '\n');
  } catch {}
}

function loadLinks() {
  try {
    const j = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
    return (j.links || []).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

let pool = [];
let stats = null;
let run = null;

async function refillPool(force = false) {
  if (!force && pool.length >= POOL_MIN) return;

  const raw = await getProxies({ force: true });
  const sample = shuffle(raw).slice(0, SAMPLE);
  console.log(`[pool] ${raw.length} candidates, validating ${sample.length}...`);

  const t0 = Date.now();
  let live = await validateProxies(sample, 300, 6000, true);

  // safety net: if stage 2 nuked everything, retry without the target check
  if (!live.length) {
    console.log('[pool] zero survived target check, retrying ipify-only...');
    live = await validateProxies(sample, 300, 6000, false);
  }

  console.log(`[pool] ${live.length} live in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  pool = shuffle(live).slice(0, POOL_TARGET);
  if (!pool.length) console.log('[pool] WARNING: zero live proxies');
}

const takeProxy = () => (pool.length ? pool.pop() : null);

async function main() {
  const links = loadLinks();
  if (!links.length) { console.error('links.json is empty'); process.exit(1); }

  stats = loadStats();
  run = { started: new Date().toISOString(), durationMinutes: DURATION_MIN, views: 0, attempts: 0, links: links.length };
  stats.runs.unshift(run);
  stats.runs = stats.runs.slice(0, 200);

  const deadline = Date.now() + DURATION_MIN * 60 * 1000;
  let sinceBreak = 0;

  console.log(`[run] ${links.length} links | ${DURATION_MIN} min | gap ${MIN_GAP}-${MAX_GAP}s`);

  setInterval(() => {
    console.log(`[hb] pool=${pool.length} views=${run.views} attempts=${run.attempts} elapsed=${Math.round((Date.now() - Date.parse(run.started)) / 60000)}min`);
  }, 60000);

  await refillPool(true);

  while (Date.now() < deadline) {
    if (TARGET_VIEWS && run.views >= TARGET_VIEWS) break;

    const link = links[run.attempts % links.length];
    let ok = false, usedProxy = null, cleared = false, clicks = 0, finalUrl = null;
    const t0 = Date.now();

    for (let t = 0; t < MAX_TRIES; t++) {
      if (Date.now() > deadline) break;
      if (pool.length < POOL_MIN) await refillPool();

      const proxy = takeProxy();
      const r = await attemptVisit(link, proxy, VISIT_BUDGET_MS);
      run.attempts++;
      stats.lifetimeAttempts++;

      if (r.completed) { ok = true; usedProxy = proxy; cleared = r.cleared; clicks = r.clicks; finalUrl = r.final; break; }
    }

    const elapsed = Date.now() - t0;
    if (ok) { run.views++; stats.lifetimeViews++; }

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${ok ? 'VIEW' : 'MISS'} ` +
      `link=${link.slice(-8)} proxy=${usedProxy || 'none'} cleared=${cleared} clicks=${clicks} ` +
      `run=${run.views}/${run.attempts} life=${stats.lifetimeViews} ${elapsed}ms`
    );

    appendCsv([new Date().toISOString(), link, ok ? 1 : 0, usedProxy || '', cleared ? 1 : 0, clicks, finalUrl || '', elapsed].join(','));
    saveStats(stats);
    sinceBreak++;

    if (sinceBreak >= BREAK_EVERY) {
      sinceBreak = 0;
      console.log(`[run] long break ${BREAK_SECONDS}s`);
      await sleep(BREAK_SECONDS * 1000);
    } else {
      await sleep(rint(MIN_GAP, MAX_GAP) * 1000);
    }
  }

  run.finished = new Date().toISOString();
  saveStats(stats);
  await closeBrowser();

  console.log(`\n=== DONE === views ${run.views} / attempts ${run.attempts} | est $${((run.views / 1000) * 1.5).toFixed(4)}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { if (run && stats) { run.finished = new Date().toISOString(); saveStats(stats); } } catch {}
    process.exit(0);
  });
}

main()
  .then(() => setTimeout(() => process.exit(0), 1500))
  .catch((e) => { console.error(e); process.exit(1); });
