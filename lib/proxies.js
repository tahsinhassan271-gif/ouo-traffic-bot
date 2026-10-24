'use strict';
/* lib/proxies.js — free proxy aggregation + latency-ranked validation.
 * Sources are public APIs/CDNs (not GitHub raw) with a few GitHub lists as backup.
 * Set EXTRA_PROXIES="ip:port,ip:port" to force-include your own (used first). */

const { ProxyAgent, fetch } = require('undici');

const TTL_MS = 8 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const PROBE_MS = Number(process.env.PROBE_TIMEOUT_MS || 4000);
const MAX_LATENCY_MS = Number(process.env.MAX_LATENCY_MS || 3500);
const CHECK_LIMIT = Number(process.env.CHECK_LIMIT || 1400);
const CONCURRENCY = 70;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SOURCES = [
  /* ---------- public APIs / CDNs (no GitHub) ---------- */
  { name: 'proxyscrape-v4', type: 'text', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=10000' },
  { name: 'proxyscrape-v2', type: 'text', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all' },
  { name: 'geonode', type: 'json', url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http,https',
    pick: function (d) { return (d && d.data ? d.data : []).map(function (x) { return x.ip + ':' + x.port; }); } },
  { name: 'proxyspace-http', type: 'text', url: 'https://proxyspace.pro/http.txt' },
  { name: 'proxyspace-https', type: 'text', url: 'https://proxyspace.pro/https.txt' },
  { name: 'proxy-list-download-http', type: 'text', url: 'https://www.proxy-list.download/api/v1/get?type=http' },
  { name: 'proxy-list-download-https', type: 'text', url: 'https://www.proxy-list.download/api/v1/get?type=https' },
  { name: 'openproxylist', type: 'text', url: 'https://api.openproxylist.xyz/http.txt' },
  { name: 'openproxy-space', type: 'json', url: 'https://openproxy.space/list/http',
    pick: function (d) {
      const out = [];
      const groups = (d && d.data) || [];
      for (let i = 0; i < groups.length; i++) {
        const items = groups[i].items || [];
        for (let j = 0; j < items.length; j++) { out.push(items[j]); }
      }
      return out;
    } },
  { name: 'advanced-name', type: 'json', url: 'https://advanced.name/freeproxy?type=http',
    pick: function (d) { return (d && d.data ? d.data : []).map(function (x) { return x.ip + ':' + x.port; }); } },
  { name: 'proxifly-jsdelivr', type: 'json', url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json',
    pick: function (d) { return (Array.isArray(d) ? d : []).map(function (x) { return String(x.proxy || '').replace(/^[a-z]+:\/\//, ''); }); } },
  { name: 'proxyscrape-ssl', type: 'text', url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=https&proxy_format=ipport&format=text&timeout=10000' },

  /* ---------- GitHub raw lists (backup) ---------- */
  { name: 'monosans', type: 'text', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { name: 'thespeedx', type: 'text', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'shiftytr', type: 'text', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' }
];

let cache = { at: 0, list: [] };

function parseText(body) {
  const out = [];
  const re = /(\d{1,3}(?:\.\d{1,3}){3})\s*[:\s]\s*(\d{2,5})/g;
  let m;
  while ((m = re.exec(body)) !== null) { out.push(m[1] + ':' + m[2]); }
  return out;
}

function extraProxies() {
  const raw = process.env.EXTRA_PROXIES || '';
  return raw.split(/[\s,;]+/)
    .map(function (s) { return s.trim().replace(/^[a-z0-9]+:\/\//i, ''); })
    .filter(Boolean);
}

async function fetchSource(src) {
  const ac = new AbortController();
  const t = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(src.url, { signal: ac.signal, headers: { 'user-agent': UA } });
    if (!r.ok) { return []; }
    const body = await r.text();
    if (src.type === 'json') {
      let d = null;
      try {
        d = JSON.parse(body);
      } catch (e) {
        return parseText(body);
      }
      if (!src.pick) { return []; }
      const picked = src.pick(d);
      return (picked || []).map(function (x) { return String(x); });
    }
    return parseText(body);
  } catch (e) {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function collect(log) {
  const results = await Promise.all(SOURCES.map(function (s) {
    return fetchSource(s).then(function (list) {
      if (log) { log('[src] ' + s.name + ' -> ' + list.length); }
      return list;
    });
  }));

  const seen = new Set();
  const out = [];

  const extras = extraProxies();
  for (let i = 0; i < extras.length; i++) {
    if (!seen.has(extras[i])) { seen.add(extras[i]); out.push(extras[i]); }
  }

  for (let i = 0; i < results.length; i++) {
    const list = results[i];
    for (let j = 0; j < list.length; j++) {
      const p = String(list[j]).trim().replace(/^[a-z0-9]+:\/\//i, '').replace(/\/$/, '');
      if (!p || seen.has(p)) { continue; }
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

async function probe(p) {
  let agent = null;
  try {
    agent = new ProxyAgent('http://' + p);
    const ac = new AbortController();
    const t = setTimeout(function () { ac.abort(); }, PROBE_MS);
    const t0 = Date.now();
    const r = await fetch('https://ouo.io/', { dispatcher: agent, signal: ac.signal, redirect: 'manual' });
    clearTimeout(t);
    if (r.status >= 500) { return 0; }
    return Date.now() - t0;
  } catch (e) {
    return 0;
  } finally {
    try { if (agent) { agent.destroy(); } } catch (e) { /* ignore */ }
  }
}

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = x[i];
    x[i] = x[j];
    x[j] = tmp;
  }
  return x;
}

async function validateProxies(list, opts) {
  const log = (opts && opts.log) || function () {};
  const sample = shuffle(list || []).slice(0, CHECK_LIMIT);
  const alive = [];
  let i = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const idx = i;
      i++;
      if (idx >= sample.length) { return; }
      const p = sample[idx];
      const ms = await probe(p);
      done++;
      if (done % 250 === 0) {
        log('[validate] ' + done + '/' + sample.length + ' checked, ' + alive.length + ' alive');
      }
      if (ms > 0 && ms <= MAX_LATENCY_MS) { alive.push({ proxy: p, ms: ms }); }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (alive.length < 10) {
    log('[validate] only ' + alive.length + ' fast, relaxing latency cap');
    alive.length = 0;
    i = 0;
    done = 0;
    async function worker2() {
      for (;;) {
        const idx = i;
        i++;
        if (idx >= sample.length) { return; }
        const ms = await probe(sample[idx]);
        done++;
        if (ms > 0) { alive.push({ proxy: sample[idx], ms: ms }); }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker2));
  }

  alive.sort(function (a, b) { return a.ms - b.ms; });
  log('[validate] ' + alive.length + ' usable (fastest ' + (alive[0] ? alive[0].ms + 'ms' : 'n/a') + ')');
  return alive.map(function (x) { return x.proxy; });
}

async function getProxies(opts) {
  const force = !!(opts && opts.force);
  const log = (opts && opts.log) || function () {};
  if (!force && cache.list.length && (Date.now() - cache.at) < TTL_MS) {
    log('[pool] cache hit ' + cache.list.length);
    return cache.list.slice();
  }
  const list = await collect(log);
  cache = { at: Date.now(), list: list };
  return list.slice();
}

module.exports = {
  getProxies: getProxies,
  validateProxies: validateProxies,
  shuffle: shuffle,
  SOURCES: SOURCES
};
