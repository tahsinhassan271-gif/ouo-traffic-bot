'use strict';
const fs = require('fs');
const path = require('path');

// The GitHub Actions bot commits its totals to data/stats.json. A Vercel
// deployment is a snapshot, so a bundled copy goes stale as soon as the bot
// runs again. Read the local file if it exists, otherwise read the committed
// file straight from the (public) repository.
const DEFAULT_REPO = 'tahsinhassan271-gif/ouo-traffic-bot';
const TTL_MS = 60 * 1000;

let cache = { at: 0, value: null };

function fromLocalFile() {
  const candidates = [
    path.join(process.cwd(), 'data', 'stats.json'),
    path.join(__dirname, '..', 'data', 'stats.json'),
  ];

  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return { raw, source: 'bundle' };
    } catch { /* try next path */ }
  }
  return null;
}

async function fromGitHub(repo, branch) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/data/stats.json`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'Cache-Control': 'no-cache' },
    cache: 'no-store',
  });
  if (!r.ok) return null;
  return { raw: await r.text(), source: 'github' };
}

function summarize(raw, source) {
  let j;
  try { j = JSON.parse(raw); } catch { return null; }

  const runs = Array.isArray(j.runs) ? j.runs : [];
  const lastRun = runs.length ? runs[0] : null;

  return {
    available: true,
    source,
    views: Number(j.lifetimeViews) || 0,
    attempts: Number(j.lifetimeAttempts) || 0,
    runs: runs.length,
    lastRun: lastRun
      ? {
        started: lastRun.started || null,
        finished: lastRun.finished || null,
        views: Number(lastRun.views) || 0,
        attempts: Number(lastRun.attempts) || 0,
      }
      : null,
  };
}

async function getBotStats() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;

  const repo = process.env.BOT_STATS_REPO || DEFAULT_REPO;
  const branch = process.env.BOT_STATS_BRANCH || 'main';

  let found = fromLocalFile();
  if (!found) found = await fromGitHub(repo, branch).catch(() => null);

  const value = found
    ? summarize(found.raw, found.source) || { available: false }
    : { available: false };

  cache = { at: Date.now(), value };
  return value;
}

module.exports = { getBotStats };
