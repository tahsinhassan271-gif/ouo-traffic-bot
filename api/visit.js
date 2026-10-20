'use strict';
const { getProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');
const { checkAccess, denied } = require('../lib/auth');

// Keep the whole handler comfortably inside vercel.json's maxDuration, browser
// cold start included.
const DEADLINE_MS = Number(process.env.VISIT_DEADLINE_MS || 90000);
const PER_ATTEMPT_MS = 30000;
const MAX_CANDIDATES = 4;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (!checkAccess(req)) return denied(res);

  try {
    const url = String(req.query.url || (req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ success: false, error: 'Missing ?url=' });

    const started = Date.now();
    const pool = await getProxies().catch(() => []);
    const candidates = shuffle(pool).slice(0, MAX_CANDIDATES);
    candidates.push(null);

    const attempts = [];
    let winner = null;

    for (const proxy of candidates) {
      const remaining = DEADLINE_MS - (Date.now() - started);
      if (remaining < 12000) break;

      const r = await attemptVisit(url, proxy, Math.min(remaining - 3000, PER_ATTEMPT_MS));
      attempts.push({
        proxy: proxy || 'direct',
        ok: r.ok,
        clicked: r.clicked,
        blocked: r.blocked,
        completed: r.completed,
        final: r.final,
        note: r.note,
      });

      if (r.completed) { winner = r; winner.proxy = proxy; break; }
    }

    // Count every candidate that was actually tried, not one per request.
    await store.bump('attempts', attempts.length).catch(() => {});
    if (winner) await store.bump('views', 1).catch(() => {});

    const entry = {
      at: new Date().toISOString(),
      source: 'dashboard',
      url,
      success: Boolean(winner),
      proxy: winner ? winner.proxy || 'direct' : null,
      final: winner ? winner.final : null,
      tries: attempts.length,
      elapsedMs: Date.now() - started,
    };
    await store.pushLog(entry).catch(() => {});

    return res.status(200).json({
      success: Boolean(winner),
      url,
      final: winner ? winner.final : null,
      proxyUsed: winner ? winner.proxy || 'direct' : null,
      elapsedMs: entry.elapsedMs,
      poolSize: pool.length,
      attempts,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[visit] failed', e);
    return res.status(500).json({
      success: false,
      error: String((e && e.message) || e),
      elapsedMs: -1,
      attempts: [],
    });
  }
};
