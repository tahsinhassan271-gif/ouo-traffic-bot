'use strict';
const { analyze } = require('../lib/phish');
const { getProxies, shuffle } = require('../lib/proxies');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const META_RE = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d*\s*;?\s*url=([^"'>\s]+)/i;
const JS_RE = /(?:location\.(?:href|replace)\s*[=(])\s*["']([^"']+)["']/i;

async function expand(url, proxy, maxHops = 12) {
  const chain = [];
  const seen = new Set();
  let current = url;

  for (let i = 0; i < maxHops; i++) {
    if (seen.has(current)) break;
    seen.add(current);

    let r;
    try {
      r = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(12000),
      });
    } catch (e) {
      chain.push({ url: current, status: null, error: String(e.message).slice(0, 120) });
      break;
    }

    const loc = r.headers.get('location');
    chain.push({ url: current, status: r.status, next: loc || null });

    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      try { current = new URL(loc, current).href; } catch { break; }
      continue;
    }

    if ([200, 403, 404].includes(r.status)) {
      const body = (await r.text().catch(() => '')).slice(0, 200000);
      const m = META_RE.exec(body) || JS_RE.exec(body);
      if (m && (m[1].startsWith('http') || m[1].startsWith('/'))) {
        let nxt = null;
        try { nxt = new URL(m[1], current).href; } catch { /* ignore */ }
        if (nxt && !seen.has(nxt)) {
          chain.push({ url: current, status: 'js/meta', next: nxt });
          current = nxt;
          continue;
        }
      }
    }
    break;
  }

  return { input: url, final: current, hops: Math.max(0, chain.length - 1), chain };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  const pool = await getProxies();
  const proxy = shuffle(pool)[0] || null;

  const result = await expand(url, proxy);
  result.phishing = analyze(result.final, result.hops, result.chain);
  result.usedProxy = proxy;

  return res.status(200).json(result);
};
