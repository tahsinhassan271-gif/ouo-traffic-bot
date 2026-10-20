'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

/**
 * The GitHub Actions bot records its totals in data/stats.json and commits them.
 * The dashboard used to ignore that file completely, so automation views never
 * showed up anywhere.
 */
function readBotStats() {
  const candidates = [
    path.join(process.cwd(), 'data', 'stats.json'),
    path.join(__dirname, '..', 'data', 'stats.json'),
  ];

  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const lastRun = Array.isArray(j.runs) && j.runs.length ? j.runs[0] : null;
      return {
        available: true,
        views: Number(j.lifetimeViews) || 0,
        attempts: Number(j.lifetimeAttempts) || 0,
        runs: Array.isArray(j.runs) ? j.runs.length : 0,
        lastRun: lastRun
          ? { started: lastRun.started || null, finished: lastRun.finished || null, views: lastRun.views || 0 }
          : null,
      };
    } catch { /* try next path */ }
  }

  return { available: false, views: 0, attempts: 0, runs: 0, lastRun: null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const [live, log] = await Promise.all([
    store.getStats(),
    store.getLog(25).catch(() => []),
  ]);
  const bot = readBotStats();

  const views = live.views + bot.views;
  const attempts = live.attempts + bot.attempts;

  return res.status(200).json({
    views,
    attempts,
    // Kept for the existing UI/consumers that read `views`/`attempts` directly.
    web: { views: live.views, attempts: live.attempts },
    bot,
    persisted: Boolean(live.persisted),
    estimatedUsd: Number(((views / 1000) * 1.5).toFixed(4)),
    log,
  });
};
