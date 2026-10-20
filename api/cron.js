'use strict';
const fs = require('fs');
const path = require('path');
const { getProxies, shuffle } = require('../lib/proxies');
const { attemptVisit } = require('../lib/visitor');
const store = require('../lib/store');
const { checkCron, denied } = require('../lib/auth');

function linksFromEnv() {
  return String(process.env.TARGET_LINKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function linksFromRepo() {
  const candidates = [
    path.join(process.cwd(), 'links.json'),
    path.join(__dirname, '..', 'links.json'),
  ];
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const links = (j.links || []).map((s) => String(s).trim()).filter(Boolean);
      if (links.length) return links;
    } catch { /* try next */ }
  }
  return [];
}

module.exports = async (req, res) => {
  if (!checkCron(req)) return denied(res);

  const links = linksFromEnv().length ? linksFromEnv() : linksFromRepo();
  if (!links.length) {
    return res.status(200).json({
      error: 'No links configured - set TARGET_LINKS or fill in links.json',
    });
  }

  const url = links[Math.floor(Math.random() * links.length)];
  const started = Date.now();

  const pool = await getProxies().catch(() => []);
  const proxy = shuffle(pool)[0] || null;

  const r = await attemptVisit(url, proxy, 45000);

  await store.bump('attempts', 1).catch(() => {});
  if (r.completed) await store.bump('views', 1).catch(() => {});

  await store.pushLog({
    at: new Date().toISOString(),
    source: 'cron',
    url,
    success: r.completed,
    clicked: r.clicked,
    blocked: r.blocked,
    proxy: proxy || 'direct',
    final: r.final,
    elapsedMs: Date.now() - started,
    note: r.note,
  }).catch(() => {});

  return res.status(200).json({
    url,
    success: r.completed,
    clicked: r.clicked,
    blocked: r.blocked,
    proxy: proxy || 'direct',
    final: r.final,
    note: r.note,
    elapsedMs: Date.now() - started,
  });
};
