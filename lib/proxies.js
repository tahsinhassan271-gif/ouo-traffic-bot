'use strict';
const { ProxyAgent, fetch } = require('undici');

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
  { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', scheme: 'socks5' },
  { url: 'https://cdn.jsdelivr.net/gh/iplocate/free-proxy-list@main/protocols/http.txt' },
  { url: 'https://www.proxy-list.download/api/v1/get?type=http' },
  { url: 'https://spys.me/proxy.txt' },
  { url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&timeout=10000' },
  { url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http', type: 'json' },
];

const RX = /\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/g;
const TTL = 10 * 60 * 1000;
let cache = { at: 0, list: [] };

const HTTP_SCHEMES = new Set(['http', 'https']);

// RFC1918 / loopback / link-local / CGNAT / documentation / multicast / reserved.
// Free proxy lists regularly contain these and they are useless (or dangerous to
// route through inside a cloud function).
function isPrivateIp(o) {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Validate and normalise one proxy entry.
 * Returns { scheme, host, port, url } or null.
 */
function parseProxy(entry) {
  const m = /^(?:(http|https|socks4|socks5):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/
    .exec(String(entry == null ? '' : entry).trim());
  if (!m) return null;

  const scheme = (m[1] || 'http').toLowerCase();
  const octets = m[2].split('.').map(Number);

  // 0.x and 255.x are never valid proxy hosts.
  if (octets.some((o) => o < 1 || o > 254)) return null;
  if (isPrivateIp(octets)) return null;

  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const host = octets.join('.');
  return { scheme, host, port, url: `${scheme}://${host}:${port}` };
}

function isHttpProxy(entry) {
  const p = parseProxy(entry);
  return Boolean(p && HTTP_SCHEMES.has(p.scheme));
}

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
      let m;
      RX.lastIndex = 0;
      while ((m = RX.exec(txt))) raw.push(`${m[1]}:${m[2]}`);
    }
    return src.scheme ? raw.map((p) => `${src.scheme}://${p}`) : raw;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function getProxies({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL && cache.list.length) return cache.list;

  const batches = await Promise.all(SOURCES.map(fetchSource));
  const set = new Set();
  for (const b of batches) for (const p of b) set.add(p);

  const list = [];
  const seen = new Set();
  for (const p of set) {
    const parsed = parseProxy(p);
    if (!parsed || seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    list.push(parsed.url);
  }

  if (list.length) cache = { at: Date.now(), list };
  return list;
}

/**
 * Probe proxies against a tiny endpoint and keep the ones that answer.
 * Only HTTP(S) proxies can be probed here: undici has no SOCKS support, so
 * socks entries are skipped (Chromium can still use them at visit time).
 */
async function validateProxies(list, concurrency = 120, timeoutMs = 7000) {
  const candidates = list.filter(isHttpProxy);
  const live = [];
  const probe = 'http://api.ipify.org';
  let i = 0;

  async function worker() {
    while (i < candidates.length) {
      const p = candidates[i++];
      const parsed = parseProxy(p);
      if (!parsed) continue;

      // connectTimeout is not a ProxyAgent option (undici ignores it); the socket
      // timeout has to be passed through proxyTls/requestTls instead.
      const agent = new ProxyAgent({
        uri: parsed.url,
        proxyTls: { timeout: timeoutMs },
        requestTls: { timeout: timeoutMs },
      });

      try {
        const r = await fetch(probe, {
          dispatcher: agent,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.ok) {
          const body = (await r.text()).trim();
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(body)) live.push(p);
        }
      } catch { /* dead proxy */ } finally {
        // Agents own sockets; leaking one per probe exhausts file descriptors.
        await agent.close().catch(() => {});
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length || 1) }, worker)
  );
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

module.exports = { getProxies, validateProxies, shuffle, parseProxy, isPrivateIp };
