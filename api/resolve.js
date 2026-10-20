'use strict';
const { ProxyAgent, fetch } = require('undici');
const { analyze } = require('../lib/phish');
const { getProxies, parseProxy, shuffle } = require('../lib/proxies');
const { assertPublicHttpUrl } = require('../lib/urlsafe');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const META_RE = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d*\s*;?\s*url=([^"'>\s]+)/i;
const JS_RE = /(?:location\.(?:href|replace)\s*[=(])\s*["']([^"']+)["']/i;

const MAX_HOPS = 12;
const TOTAL_BUDGET_MS = 25000;
const HOP_TIMEOUT_MS = 8000;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function hopFetch(url, proxy, timeoutMs) {
  const agent = proxy ? new ProxyAgent({ uri: proxy, requestTls: { timeout: timeoutMs } }) : null;
  try {
    return await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
      ...(agent ? { dispatcher: agent } : {}),
    });
  } finally {
    if (agent) await agent.close().catch(() => {});
  }
}

async function expand(startUrl, proxy, deadline) {
  const chain = [];
  const seen = new Set();
  let current = startUrl;
  let hops = 0;
  let usedProxy = null;

  for (let i = 0; i < MAX_HOPS; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) {
      chain.push({ url: current, status: null, error: 'time budget exhausted', via: 'budget' });
      break;
    }
    if (seen.has(current)) {
      chain.push({ url: current, status: null, error: 'redirect loop', via: 'loop' });
      break;
    }
    seen.add(current);

    const timeoutMs = Math.min(HOP_TIMEOUT_MS, remaining);
    let r;
    let via = proxy ? 'proxy' : 'direct';

    try {
      r = await hopFetch(current, proxy, timeoutMs);
      if (proxy) usedProxy = proxy;
    } catch (e) {
      // A dead proxy should not break the whole scan.
      if (proxy) {
        try {
          r = await hopFetch(current, null, Math.min(HOP_TIMEOUT_MS, deadline - Date.now()));
          via = 'direct-fallback';
          usedProxy = null;
        } catch (e2) {
          chain.push({ url: current, status: null, error: String(e2.message).slice(0, 120), via });
          break;
        }
      } else {
        chain.push({ url: current, status: null, error: String(e.message).slice(0, 120), via });
        break;
      }
    }

    const loc = r.headers.get('location');
    chain.push({ url: current, status: r.status, next: loc || null, via });

    if (REDIRECTS.has(r.status) && loc) {
      let next;
      try { next = new URL(loc, current); } catch { break; }
      try { await assertPublicHttpUrl(next.href); } catch (e) {
        chain.push({ url: next.href, status: null, error: String(e.message), via: 'blocked' });
        break;
      }
      current = next.href;
      hops++;
      continue;
    }

    if ([200, 403, 404].includes(r.status)) {
      const body = (await r.text().catch(() => '')).slice(0, 200000);
      const m = META_RE.exec(body) || JS_RE.exec(body);
      if (m && (m[1].startsWith('http') || m[1].startsWith('/'))) {
        let next = null;
        try { next = new URL(m[1], current); } catch { /* ignore */ }
        if (next && !seen.has(next.href)) {
          try { await assertPublicHttpUrl(next.href); } catch { next = null; }
        }
        if (next && !seen.has(next.href)) {
          // One chain entry per hop: the previous version pushed this URL twice,
          // which duplicated rows in the UI and inflated the hop count.
          chain[chain.length - 1].via = 'js/meta';
          chain[chain.length - 1].next = next.href;
          current = next.href;
          hops++;
          continue;
        }
      }
    }
    break;
  }

  return { input: startUrl, final: current, hops, chain, usedProxy };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing ?url=' });

  let url;
  try {
    url = (await assertPublicHttpUrl(raw)).href;
  } catch (e) {
    return res.status(400).json({ error: String(e.message), input: raw });
  }

  const pool = await getProxies().catch(() => []);
  const proxy = shuffle(pool).filter((p) => {
    const parsed = parseProxy(p);
    return parsed && (parsed.scheme === 'http' || parsed.scheme === 'https');
  })[0] || null;

  const started = Date.now();
  const result = await expand(url, proxy, started + TOTAL_BUDGET_MS);
  result.phishing = analyze(result.final, result.hops, result.chain);
  // `usedProxy` used to be reported even though the proxy was never used.
  result.usedProxy = result.usedProxy || null;
  result.proxy = result.usedProxy ? 'used' : 'direct';
  result.elapsedMs = Date.now() - started;

  return res.status(200).json(result);
};
