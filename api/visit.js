'use strict';
const { getProxies, validateProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');

const DEADLINE_MS = 52000;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = String(req.query.url || (req.body && req.body.url) || '').trim();
    if (!url) return res.status(200).json({ success: false, error: 'Missing ?url=' });

    const started = Date.now();
    const pool = await getProxies();

    // validate a batch in parallel first so we don't waste the budget on dead proxies
    const candidates = shuffle(pool).slice(0, 40);
    const live = await validateProxies(candidates, 40, 6000, false);
    const queue = (live.length ? shuffle(live) : shuffle(pool)).slice(0, 4);

    const attempts = [];
    let winner = null;

    for (const proxy of queue) {
      const remaining = DEADLINE_MS - (Date.now() - started);
      if (remaining < 12000) break;

      const r = await attemptVisit(url, proxy, Math.min(remaining - 1500, 32000));
      attempts.push({
        proxy: proxy || 'direct', ok: r.ok, cleared: r.cleared,
        clicks: r.clicks, completed: r.completed, final: r.final, note: r.note,
      });

      if (r.completed) { winner = r; break; }
    }

    await store.bump('attempts', 1).catch(() => {});
    if (winner) await store.bump('views', 1).catch(() => {});

    return res.status(200).json({
      success: Boolean(winner),
      url,
      final: winner ? winner.final : null,
      proxyUsed: winner ? winner.proxy : null,
      elapsedMs: Date.now() - started,
      poolSize: pool.length,
      liveCount: live.length,
      attempts,
    });
  } catch (e) {
    return res.status(200).json({
      success: false,
      error: String((e && e.message) || e),
      where: String((e && e.stack) || '').split('\n')[1] || '',
      elapsedMs: -1,
      attempts: [],
    });
  }
};
