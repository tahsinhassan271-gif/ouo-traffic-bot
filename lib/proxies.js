'use strict';
const { ProxyAgent } = require('undici');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

const SOURCES = [
  { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
  { url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt' },
  { url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' },
  { url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt' },
  { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt' },
  { url: 'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt' },
  { url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt' },
  { url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt' },
  { url: 'https://cdn.jsdelivr.net/gh/iplocate/free-proxy-list@main/protocols/http.txt' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=http' },
  { url: 'https://spys.me/proxy.txt' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=10000' },
  { url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', type: 'json' },
];

const RX = /\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g;
const TTL = 10 * 60 * 1000;
let cache = { at: 0, list: [] };

async function fetchSource(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(src.url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) return [];
    let raw = [];
    if (src.type === 'json') {
      const j = await r.json();
      raw = (j.data || []).map((p) => `${p.ip}:${p.port}`);
    } else {
      const txt = await r.text();
      let m; RX.lastIndex = 0;
      while ((m = RX.exec(txt))) raw.push(`${m[1]}:${m[2]}`);
    }
    return raw;
  } catch { return []; } finally { clearTimeout(timer); }
}

async function getProxies({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL && cache.list.length) return cache.list;
  const batches = await Promise.all(SOURCES.map(fetchSource));
  const set = new Set();
  for (const b of batches) for (const p of b) set.add(p);
  const list = [...set].filter((p) => {
    const port = Number(p.split(':').pop());
    return port > 0 && port < 65536;
  });
  if (list.length) cache = { at: Date.now(), list };
  return list;
}

// returns round-trip ms, or null on failure. Never hangs.
function probe(proxy, url, timeoutMs, expectIp) {
  const uri = proxy.includes('://') ? proxy : `http://${proxy}`;
  const agent = new ProxyAgent({ uri });
  const t0 = Date.now();
  const hard = new Promise((res) => setTimeout(() => res(null), timeoutMs + 2000));

  const work = (async () => {
    const r = await fetch(url, {
      dispatcher: agent,
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (r.status >= 500) return null;
    if (expectIp) {
      const ip = (await r.text()).trim();
      if (!IP_RE.test(ip)) return null;
    }
    return Date.now() - t0;
  })().catch(() => null);

  return Promise.race([work, hard]).finally(() => {
    try { agent.destroy(); } catch { /* ignore */ }
  });
}

async function runPool(list, worker, concurrency) {
  let i = 0;
  async function loop() { while (i < list.length) await worker(list[i++]); }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, loop));
}

// Returns live proxies sorted FASTEST FIRST.
async function validateProxies(list, concurrency = 300, timeoutMs = 6000, checkTarget = false) {
  const stage1 = [];
  let done = 0;
  await runPool(list, async (p) => {
    const ms = await probe(p, 'https://api.ipify.org', timeoutMs, true);
    if (ms !== null) stage1.push({ p, ms });
    if (++done % 250 === 0) console.log(`[validate] ${done}/${list.length} checked, ${stage1.length} alive`);
  }, concurrency);

  stage1.sort((a, b) => a.ms - b.ms);
  let live = stage1.map((x) => x.p);

  if (checkTarget && live.length) {
    const passed = [];
    await runPool(live, async (p) => {
      const ms = await probe(p, 'https://ouo.io/', timeoutMs, false);
      if (ms !== null) passed.push({ p, ms });
    }, 60);
    passed.sort((a, b) => a.ms - b.ms);
    const set = new Set(passed.map((x) => x.p));
    live = [...passed.map((x) => x.p), ...live.filter((p) => !set.has(p))];
  }

  return live;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { getProxies, validateProxies, shuffle };
