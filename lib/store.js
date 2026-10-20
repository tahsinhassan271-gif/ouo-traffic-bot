'use strict';

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = { views: 0, attempts: 0, log: [] };

async function redis(...parts) {
  if (!R_URL || !R_TOKEN) return null;
  try {
    const r = await fetch(`${R_URL}/${parts.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${R_TOKEN}` },
      cache: 'no-store',
    });
    const j = await r.json();
    return j.result;
  } catch {
    return null;
  }
}

async function bump(key, by = 1) {
  const r = await redis('incrby', key, String(by));
  if (r === null) {
    mem[key] = (mem[key] || 0) + by;
    return mem[key];
  }
  return Number(r) || 0;
}

async function getStats() {
  const [v, a] = await Promise.all([redis('get', 'views'), redis('get', 'attempts')]);
  return {
    views: v === null ? mem.views : Number(v) || 0,
    attempts: a === null ? mem.attempts : Number(a) || 0,
    persisted: Boolean(R_URL && R_TOKEN),
  };
}

async function pushLog(entry) {
  const r = await redis('lpush', 'log', JSON.stringify(entry));
  if (r === null) {
    mem.log.unshift(entry);
    mem.log = mem.log.slice(0, 100);
    return;
  }
  await redis('ltrim', 'log', '0', '199');
}

async function getLog(limit = 30) {
  const r = await redis('lrange', 'log', '0', String(limit - 1));
  if (r === null) return mem.log.slice(0, limit);
  return (r || [])
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { bump, getStats, pushLog, getLog };
