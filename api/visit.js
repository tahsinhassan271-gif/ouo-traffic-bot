'use strict';
const { getProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');

const DEADLINE_MS = 45000;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = String(req.query.url || (req.body && req.body.url) || '').trim();
    if (!url) return res.status(200).json({ success: false, error: 'Missing ?url=' });

    const started = Date.now();
    const pool = await getProxies();
    const candidates = shuffle(pool).slice(0, 5);
    candidates.push(null);

    const attempts = [];
    let winner = null;

    for (const proxy of candidates) {
      const remaining = DEADLINE_MS - (Date.now() - started);
      if (remaining < 11000) break;

      const r = await attemptVisit(url, proxy, Math.min(remaining - 2000, 30000));
      attempts.push({
        proxy: proxy || 'direct',
        ok: r.ok,
        clicked: r.clicked,
        final: r.final,
        note: r.note,
      });

      if (r.ok && r.completed) { winner = r; break; }
    }

    await store.bump('attempts', 1).catch(() => {});
    if (winner) await store.bump('views', 1).catch(() => {});

    return res.status(200).json({
      success: Boolean(winner),
      url,
      final: winner ? winner.final : null,
      proxyUsed: winner ? winner.proxy || 'direct' : null,
      elapsedMs: Date.now() - started,
      poolSize: pool.length,
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
