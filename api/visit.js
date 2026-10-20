'use strict';
const { getProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');

const DEADLINE_MS = 54000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const url = String(req.query.url || (req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  const started = Date.now();
  const pool = await getProxies();
  const candidates = shuffle(pool).slice(0, 8);
  candidates.push(null);

  const attempts = [];
  let winner = null;

  for (const proxy of candidates) {
    const remaining = DEADLINE_MS - (Date.now() - started);
    if (remaining < 13000) break;

    const r = await attemptVisit(url, proxy, remaining - 3000);
    attempts.push({
      proxy: proxy || 'direct',
      ok: r.ok,
      clicked: r.clicked,
      final: r.final,
      note: r.note,
    });

    if (r.ok && r.completed) { winner = r; break; }
  }

  await store.bump('attempts', 1);
  if (winner) await store.bump('views', 1);
  await store.pushLog({
    url,
    ok: Boolean(winner),
    proxy: winner ? winner.proxy || 'direct' : null,
    final: winner ? winner.final : null,
    at: Date.now(),
  });

  return res.status(200).json({
    url,
    success: Boolean(winner),
    viewsThisRun: winner ? 1 : 0,
    final: winner ? winner.final : null,
    proxyUsed: winner ? winner.proxy || 'direct' : null,
    elapsedMs: Date.now() - started,
    poolSize: pool.length,
    attempts,
  });
};
