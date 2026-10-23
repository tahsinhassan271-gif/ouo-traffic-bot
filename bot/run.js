'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LINKS_FILE = path.join(ROOT, 'links.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.jsonl');

const int = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DURATION_MIN = int(process.env.DURATION_MINUTES, 20);
const TARGET_VIEWS = int(process.env.TARGET_VIEWS, 0);
const MIN_GAP = int(process.env.MIN_GAP_SECONDS, 3);
const MAX_GAP = int(process.env.MAX_GAP_SECONDS, 12);
const BREAK_EVERY = int(process.env.BREAK_EVERY, 20);
const BREAK_SEC = int(process.env.BREAK_SECONDS, 90);
const WORKERS = Math.max(1, int(process.env.WORKERS, 2));
const POOL_MIN = int(process.env.POOL_MIN, 8);
const VISIT_BUDGET = int(process.env.VISIT_BUDGET_MS, 95000);

const START = Date.now();
const DEADLINE = START + DURATION_MIN * 60000;

const { attemptVisit } = require('../lib/visitor');
const { closeBrowser } = require('../lib/browser');

function safeRequire(p) {
  try { return require(p); } catch (e) { console.log('[warn] require', p, '-', e.message); return null; }
}

/* ---------------- links ---------------- */
function loadLinks() {
  try {
    const raw = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.links || raw.urls || []);
    return arr.map(x => (typeof x === 'string' ? x : (x && (x.url || x.link)))).filter(Boolean);
  } catch (e) {
    console.log('[run] links.json unreadable:', e.message);
    return [];
  }
}

/* ---------------- stats ---------------- */
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch (_) {
    return { views: 0, attempts: 0, lifetimeViews: 0, lifetimeAttempts: 0, updatedAt: null, links: {} };
  }
}

function saveStats(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    s.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.log('[warn] saveStats', e.message); }
}

function logRun(link, res) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(RUNS_FILE, JSON.stringify({
      at: new Date().toISOString(), link, proxy: res.proxy, ok: res.ok, cf: res.cf,
      hops: res.hops, clicks: res.clicks, done: res.done, ms: res.ms, note: res.note,
    }) + '\n');
  } catch (_) {}
}

/* ---------------- proxies ---------------- */
function normalizeProxies(a) {
  return (a || []).map(x => {
    if (!x) return null;
    if (typeof x === 'string') return x;
    return x.proxy || x.url || x.addr || x.address || null;
  }).map(s => (s ? String(s).replace(/^[a-z0-9]+:\/\//i, '').replace(/\/$/, '') : null))
    .filter(Boolean);
}

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

async function naiveValidate(list, limit) {
  const { ProxyAgent, fetch } = require('undici');
  const sample = list.slice(0, limit || 600);
  const out = [];
  let i = 0;
  async function worker() {
    while (i < sample.length) {
      const p = sample[i++];
      let agent;
      try {
        agent = new ProxyAgent('http://' + p);
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 4000);
        const r = await fetch('https://ouo.io/', { dispatcher: agent, signal: ac.signal, redirect: 'manual' });
        clearTimeout(t);
        if (r.status < 500) out.push(p);
      } catch (_) {}
      finally { try { agent && agent.destroy(); } catch (_) {} }
    }
  }
  await Promise.all(Array.from({ length: 60 }, worker));
  return out;
}

async function buildPool(state) {
  const P = safeRequire('../lib/proxies');
  let list = [];

  const fn = P && (P.getProxies || P.fetchProxies || P.collectProxies || P.collect || P.all);
  if (typeof fn === 'function') {
    try {
      const r = await fn();
      list = normalizeProxies(Array.isArray(r) ? r : (r && (r.proxies || r.list || r.all)) || []);
    } catch (e) { console.log('[pool] fetch failed:', e.message); }
  }
  console.log(`[pool] ${list.length} candidates`);
  if (!list.length) return;

  let live = [];
  const vf = P && (P.validateProxies || P.validate || P.checkProxies);
  if (typeof vf === 'function') {
    try { live = normalizeProxies(await vf(list, { log: console.log })); }
    catch (e) { console.log('[pool] validate failed:', e.message); }
  }
  if (live.length < 5) {
    console.log('[pool] falling back to built-in validation...');
    live = await naiveValidate(list, 700);
  }
  state.pool.push(...shuffle(live));
  console.log(`[pool] ${state.pool.length} live`);
}

async function refill(state) {
  if (state.refilling) { await sleep(600); return; }
  if (state.pool.length >= POOL_MIN) return;
  state.refilling = true;
  try {
    const P = safeRequire('../lib/proxies');
    const fn = P && (P.getProxies || P.fetchProxies || P.collectProxies);
    if (typeof fn !== 'function') return;
    const r = await fn();
    let list = shuffle(normalizeProxies(Array.isArray(r) ? r : (r && (r.proxies || r.list)) || [])).slice(0, 600);
    if (!list.length) return;
    const vf = P && (P.validateProxies || P.validate);
    let live = typeof vf === 'function' ? normalizeProxies(await vf(list, { log: () => {} })) : await naiveValidate(list, 400);
    const have = new Set(state.pool);
    live = live.filter(p => !have.has(p));
    state.pool.push(...live);
    console.log(`[pool] refill +${live.length} -> ${state.pool.length}`);
  } catch (e) {
    console.log('[pool] refill failed:', e.message);
  } finally {
    state.refilling = false;
  }
}

/* ---------------- attempt race (belt + braces) ---------------- */
function raceAttempt(p, ms) {
  let t = null;
  const guard = new Promise(res => {
    t = setTimeout(() => res({
      ok: false, cf: false, hops: 0, cleared: false, clicks: 0, done: false,
      note: 'HARD TIMEOUT', ms, dbg: null,
    }), ms);
  });
  return Promise.race([p.catch(e => ({
    ok: false, cf: false, hops: 0, cleared: false, clicks: 0, done: false,
    note: String((e && e.message) || e).split('\n')[0].slice(0, 120), ms: 0, dbg: null,
  })), guard]).finally(() => { if (t) clearTimeout(t); });
}

/* ---------------- worker ---------------- */
async function worker(state, stats, links) {
  while (!state.stop) {
    if (Date.now() >= DEADLINE) { state.stop = true; break; }
    if (TARGET_VIEWS > 0 && state.views >= TARGET_VIEWS) { state.stop = true; break; }

    const proxy = state.pool.shift();
    if (!proxy) {
      await refill(state);
      if (!state.pool.length) await sleep(2500);
      continue;
    }

    const link = links[state.li++ % links.length];
    const tag = link.replace(/^https?:\/\/[^/]+/, '');
    state.attempts++;
    stats.attempts++;
    stats.lifetimeAttempts = (stats.lifetimeAttempts || 0) + 1;

    console.log(`        [visit] ${tag} pool=${state.pool.length}`);
    const res = await raceAttempt(attemptVisit(proxy, link, { log: console.log }), VISIT_BUDGET + 20000);

    const t = new Date().toISOString().slice(11, 19);
    console.log(`        [try] ${proxy} ok=${res.ok} cf=${res.cf} hops=${res.hops} cleared=${res.cleared} clicks=${res.clicks} done=${res.done} ${res.ms}ms${res.note ? ' | ' + res.note : ''}`);
    if (res.dbg) console.log(`        dbg=${JSON.stringify(res.dbg).slice(0, 400)}`);

    const key = tag;
    stats.links[key] = stats.links[key] || { views: 0, attempts: 0 };
    stats.links[key].attempts++;

    if (res.done) {
      state.views++;
      stats.views++;
      stats.links[key].views++;
      stats.lifetimeViews = (stats.lifetimeViews || 0) + 1;
      console.log(`[${t}] VIEW link=${tag} cf=${res.cf} hops=${res.hops} clicks=${res.clicks} run=${state.views}/${state.attempts} life=${stats.lifetimeViews} ${res.ms}ms`);
    } else {
      console.log(`[${t}] MISS link=${tag} cf=${res.cf} hops=${res.hops} clicks=${res.clicks} run=${state.views}/${state.attempts} life=${stats.lifetimeViews || 0} ${res.ms}ms`);
    }

    logRun(link, res);
    saveStats(stats);

    state.sinceBreak++;
    if (BREAK_EVERY > 0 && state.sinceBreak % BREAK_EVERY === 0) {
      console.log(`[break] ${BREAK_SEC}s`);
      await sleep(BREAK_SEC * 1000);
    } else {
      await sleep((MIN_GAP + Math.random() * Math.max(0, MAX_GAP - MIN_GAP)) * 1000);
    }
  }
}

/* ---------------- main ---------------- */
async function main() {
  const links = loadLinks();
  if (!links.length) { console.log('[run] no links in links.json'); return; }

  console.log(`[run] ${links.length} links | ${DURATION_MIN} min | gap ${MIN_GAP}-${MAX_GAP}s | workers ${WORKERS}`);

  const stats = loadStats();
  const state = { pool: [], refilling: false, stop: false, views: 0, attempts: 0, li: 0, sinceBreak: 0 };

  await buildPool(state);

  const hb = setInterval(() => {
    const el = Math.round((Date.now() - START) / 60000);
    console.log(`[hb] pool=${state.pool.length} views=${state.views} attempts=${state.attempts} elapsed=${el}min`);
  }, 60000);

  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(worker(state, stats, links));
  await Promise.all(workers);

  clearInterval(hb);
  saveStats(stats);

  console.log(`\n=== DONE === views ${state.views} / attempts ${state.attempts} | est $${(state.views * 0.0015).toFixed(4)}`);

  await closeBrowser().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => { console.log('\n[signal] SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[signal] SIGTERM'); process.exit(0); });

main().catch(e => {
  console.log('[fatal]', e && e.stack ? e.stack : e);
  process.exit(1);
});
