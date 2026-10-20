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
const VISIT_BUDGET_MS = 40000;

fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS, 'utf8')); }
  catch {
    return {
      lifetimeViews: 0,
      lifetimeAttempts: 0,
      firstRun: new Date().toISOString(),
      runs: [],
    };
  }
}
const saveStats = (s) => fs.writeFileSync(STATS, JSON.stringify(s, null, 2));

function appendCsv(row) {
  if (!fs.existsSync(CSV)) {
    fs.writeFileSync(CSV, 'timestamp,link,success,proxy,final,elapsed_ms\n');
  }
  fs.appendFileSync(CSV, row + '\n');
}

function loadLinks() {
  try {
    const j = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
    return (j.links || []).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

let pool = [];

async function refillPool(force = false) {
  if (!force && pool.length >= POOL_MIN) return;
  console.log('[pool] fetching all sources...');
  const raw = await getProxies({ force: true });
  console.log(`[pool] ${raw.length} candidates, health-checking 1000...`);
  const sample = shuffle(raw).slice(0, 1000);
  const live = await validateProxies(sample, 150);
  pool = shuffle(live).slice(0, POOL_TARGET);
  console.log(`[pool] ${live.length} live, holding ${pool.length}`);
}

const takeProxy = () => (pool.length ? pool.pop() : null);

async function main() {
  const links = loadLinks();
  if (!links.length) {
    console.error('links.json is empty - add your ouo links');
    process.exit(1);
  }

  const stats = loadStats();
  const run = {
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

  console.log(`[run] ${links.length} links | ${DURATION_MIN} min | gap ${MIN_GAP}-${MAX_GAP}s | break every ${BREAK_EVERY}`);

  await refillPool(true);

  while (Date.now() < deadline) {
    if (TARGET_VIEWS && run.views >= TARGET_VIEWS) {
      console.log('[run] target reached');
      break;
    }

    const link = links[run.attempts % links.length];
    let ok = false, usedProxy = null, finalUrl = null;
    const t0 = Date.now();

    for (let t = 0; t < MAX_TRIES_PER_VISIT; t++) {
      if (Date.now() > deadline) break;
      if (pool.length < POOL_MIN) await refillPool();

      const proxy = takeProxy();
      const r = await attemptVisit(link, proxy, VISIT_BUDGET_MS);
      run.attempts++;
      stats.lifetimeAttempts++;

      if (r.ok && r.completed) {
        ok = true;
        usedProxy = proxy;
        finalUrl = r.final;
        break;
      }
    }

    const elapsed = Date.now() - t0;
    if (ok) { run.views++; stats.lifetimeViews++; }

    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${ok ? 'VIEW' : 'MISS'} ` +
      `link=${link.slice(-8)} proxy=${usedProxy || 'direct'} ` +
      `run=${run.views}/${run.attempts} life=${stats.lifetimeViews} ${elapsed}ms`
    );

    appendCsv([new Date().toISOString(), link, ok ? 1 : 0, usedProxy || 'direct', finalUrl || '', elapsed].join(','));
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
  run.poolAtEnd = pool.length;
  saveStats(stats);
  await closeBrowser();

  const est = ((run.views / 1000) * 1.5).toFixed(4);
  console.log(`\n=== DONE === views ${run.views} / attempts ${run.attempts} | est $${est} | lifetime ${stats.lifetimeViews}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
