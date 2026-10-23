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
const MIN_GAP = Number(process.env.MIN_GAP_SECONDS || 3);
const MAX_GAP = Number(process.env.MAX_GAP_SECONDS || 12);
const BREAK_EVERY = Number(process.env.BREAK_EVERY || 20);
const BREAK_SECONDS = Number(process.env.BREAK_SECONDS || 90);

const POOL_MIN = 12;
const POOL_TARGET = 200;
const SAMPLE = 1000;
const MAX_TRIES = 2;
const VISIT_BUDGET_MS = 110000;

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
    if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'timestamp,link,success,proxy,cf,hops,clicks,final,elapsed_ms\n');
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
let refilling = false;

async function refillPool() {
  if (refilling) return;
  refilling = true;
  try {
    const raw = await getProxies({ force: true });
    const sample = shuffle(raw).slice(0, SAMPLE);
    console.log(`[pool] ${raw.length} candidates, validating ${sample.length}...`);
    const t0 = Date.now();

    let live = await validateProxies(sample, 300, 6000, false);
    if (live.length > 200) live = live.slice(0, 200);

    if (live.length) {
      const passers = await validateProxies(live, 60, 9000, true);
      const set = new Set(passers);
      console.log(`[pool] ${passers.length}/${live.length} reach ouo.io directly`);
      live = [...passers, ...live.filter((p) => !set.has(p))];
    }

    console.log(`[pool] ${live.length} live in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (live.length) pool = live.slice(0, POOL_TARGET).reverse(); // pop() = fastest first
  } finally {
    refilling = false;
  }
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
    console.log(`[hb] pool=${pool.length} views=${run.views} attempts=${run.attempts} ` +
      `elapsed=${Math.round((Date.now() - Date.parse(run.started)) / 60000)}min`);
  }, 60000);

  await refillPool();

  // ---- diagnostic: does the flow work at all from the runner's own IP? ----
  if (process.env.DIRECT_PROBE !== '0') {
    console.log('[probe] testing flow with NO proxy (runner IP)...');
    const r = await attemptVisit(links[0], null, VISIT_BUDGET_MS);
    console.log(`[probe] ok=${r.ok} cf=${r.cf} hops=${r.hops} cleared=${r.cleared} ` +
      `clicks=${r.clicks} done=${r.completed} note=${r.note}`);
    if (r.dbg) console.log('[probe-dbg] ' + JSON.stringify(r.dbg));
  }

  while (Date.now() < deadline) {
    if (pool.length < POOL_MIN) {
      await refillPool();
      if (pool.length === 0) { console.log('[pool] empty, waiting 10s'); await sleep(10000); continue; }
    }

    const link = links[run.attempts % links.length];
    let ok = false, usedProxy = null, cf = false, hops = 0, cleared = false, clicks = 0, finalUrl = null;
    const t0 = Date.now();

    console.log(`[visit] ${link.slice(-8)} pool=${pool.length}`);

    for (let t = 0; t < MAX_TRIES && Date.now() < deadline; t++) {
      const proxy = takeProxy();
      const rt0 = Date.now();
      const r = await attemptVisit(link, proxy, VISIT_BUDGET_MS);
      run.attempts++;
      stats.lifetimeAttempts++;

      console.log(
        `[try${t + 1}] ${proxy || 'direct'} ok=${r.ok} cf=${r.cf} hops=${r.hops} cleared=${r.cleared} ` +
        `clicks=${r.clicks} done=${r.completed} ${Date.now() - rt0}ms${r.note ? ' | ' + r.note : ''}`
      );
      if (r.dbg) console.log('        dbg=' + JSON.stringify(r.dbg));

      if (r.completed) {
        ok = true; usedProxy = proxy; cf = r.cf; hops = r.hops;
        cleared = r.cleared; clicks = r.clicks; finalUrl = r.final;
        break;
      }
    }

    const elapsed = Date.now() - t0;
    if (ok) { run.views++; stats.lifetimeViews++; }

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${ok ? 'VIEW' : 'MISS'} ` +
      `link=${link.slice(-8)} cf=${cf} hops=${hops} clicks=${clicks} ` +
      `run=${run.views}/${run.attempts} life=${stats.lifetimeViews} ${elapsed}ms`
    );

    appendCsv([new Date().toISOString(), link, ok ? 1 : 0, usedProxy || '', cf ? 1 : 0, hops, clicks, finalUrl || '', elapsed].join(','));
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
