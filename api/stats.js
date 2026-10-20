'use strict';
const store = require('../lib/store');
const { getBotStats } = require('../lib/botstats');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const [live, log, bot] = await Promise.all([
    store.getStats(),
    store.getLog(25).catch(() => []),
    getBotStats().catch(() => ({ available: false })),
  ]);

  const botViews = bot.available ? bot.views : 0;
  const botAttempts = bot.available ? bot.attempts : 0;
  const views = live.views + botViews;
  const attempts = live.attempts + botAttempts;

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
