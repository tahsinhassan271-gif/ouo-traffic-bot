'use strict';
const { getProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');

module.exports = async (req, res) => {
  const links = String(process.env.TARGET_LINKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!links.length) {
    return res.status(200).json({ error: 'Set TARGET_LINKS env var (comma separated)' });
  }

  const url = links[Math.floor(Math.random() * links.length)];
  const pool = await getProxies();
  const proxy = shuffle(pool)[0] || null;

  const r = await attemptVisit(url, proxy, 45000);

  await store.bump('attempts', 1);
  if (r.ok && r.completed) await store.bump('views', 1);

  return res.status(200).json({ url, success: r.ok && r.completed, proxy: proxy || 'direct' });
};
