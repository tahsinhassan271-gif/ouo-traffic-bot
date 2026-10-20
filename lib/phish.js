'use strict';

const SUSPICIOUS_TLDS = new Set([
  'tk','ml','ga','cf','gq','xyz','top','zip','click','link','work','loan','cam',
  'rest','country','stream','download','racing','party','science','gdn','bid',
  'review','win','men','date','faith','cricket','accountant','trade','webcam',
]);

const BRANDS = [
  'paypal','google','microsoft','apple','amazon','netflix','facebook','instagram',
  'whatsapp','binance','coinbase','metamask','steam','dhl','fedex','office365',
  'outlook','dropbox','adobe','icloud','linkedin','twitter','telegram','spotify',
  'roblox','discord','chase','wellsfargo','santander','poste','bradesco',
];

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function analyze(finalUrl, hops, chain) {
  let score = 0;
  const flags = [];

  let parsed;
  try { parsed = new URL(finalUrl); } catch {
    return { score: 50, band: 'medium', flags: ['Unparseable final URL'], host: '', registered_domain: '' };
  }

  const host = parsed.hostname.toLowerCase();
  const parts = host.split('.');
  const tld = parts[parts.length - 1] || '';
  const domainWord = parts.length >= 2 ? parts[parts.length - 2] : host;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    score += 25; flags.push('Host is a raw IP address');
  }
  if (host.includes('xn--')) {
    score += 20; flags.push('Punycode domain - possible homoglyph attack');
  }
  if (SUSPICIOUS_TLDS.has(tld)) {
    score += 12; flags.push(`Suspicious TLD .${tld}`);
  }

  for (const b of BRANDS) {
    if (domainWord === b) break;
    const d = levenshtein(domainWord, b);
    if (d > 0 && d <= 2 && domainWord.length >= 5) {
      score += 18; flags.push(`Domain "${domainWord}" mimics brand "${b}" (edit distance ${d})`);
      break;
    }
    if (host.includes(b) && !domainWord.includes(b)) {
      score += 15; flags.push(`Brand "${b}" appears in subdomain but not the registered domain`);
      break;
    }
  }

  if ((host.match(/-/g) || []).length >= 3) { score += 8; flags.push('Three or more hyphens in hostname'); }
  if (parts.length >= 5) { score += 8; flags.push('Excessive subdomain depth'); }
  if (finalUrl.length > 120) { score += 6; flags.push('Very long URL'); }
  if (parsed.username) { score += 12; flags.push('"@" in authority - real host may be hidden'); }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    score += 5; flags.push(`Non-standard port ${parsed.port}`);
  }
  if (hops >= 4) { score += 10; flags.push(`Long redirect chain (${hops} hops)`); }
  if (chain.some((h) => h.status === 'js/meta')) {
    score += 6; flags.push('JS / meta-refresh redirect - harder to inspect statically');
  }

  score = Math.min(score, 100);
  const band = score < 25 ? 'low' : score < 55 ? 'medium' : 'high';

  return {
    score,
    band,
    flags: flags.length ? flags : ['No obvious red flags'],
    host,
    registered_domain: parts.slice(-2).join('.'),
  };
}

module.exports = { analyze };
