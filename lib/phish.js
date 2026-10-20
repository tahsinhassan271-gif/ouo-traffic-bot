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

// Common multi-label public suffixes. Without this, `slice(-2)` turns
// apple.co.uk into "co.uk" and flags perfectly legitimate sites.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk','org.uk','ac.uk','gov.uk','me.uk','net.uk','sch.uk','ltd.uk','plc.uk',
  'co.jp','ne.jp','or.jp','ac.jp','go.jp','ed.jp','gr.jp','lg.jp',
  'co.kr','or.kr','ne.kr','go.kr','ac.kr',
  'co.in','net.in','org.in','gen.in','firm.in','ind.in','ac.in','gov.in',
  'co.nz','net.nz','org.nz','govt.nz','ac.nz',
  'co.za','org.za','net.za','gov.za','ac.za',
  'com.au','net.au','org.au','edu.au','gov.au','asn.au','id.au',
  'com.br','net.br','org.br','gov.br','edu.br',
  'com.cn','net.cn','org.cn','gov.cn','edu.cn','ac.cn',
  'com.mx','com.ar','com.tr','com.sg','com.hk','com.tw','com.my','com.ph',
  'com.vn','com.pk','com.sa','com.eg','com.ng','com.ua','com.pl','com.ru',
  'com.co','com.pe','com.ec','com.uy','com.py','com.bo','com.do','com.gt',
  'com.sv','com.hn','com.ni','com.pa','com.ve','com.es','com.pt',
  'co.id','co.th','co.il','co.at','co.no','co.ve','co.ke','co.tz','co.ug',
]);

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

/**
 * Best-effort registrable domain (eTLD+1) using the suffix list above.
 * Falls back to the last two labels for unknown suffixes.
 */
function registrableDomain(host) {
  const raw = String(host || '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw) || raw.includes(':')) return raw;

  const parts = raw.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function analyze(finalUrl, hops = 0, chain = []) {
  let score = 0;
  const flags = [];

  let parsed;
  try { parsed = new URL(finalUrl); } catch {
    return { score: 50, band: 'medium', flags: ['Unparseable final URL'], host: '', registered_domain: '' };
  }

  const host = parsed.hostname.toLowerCase();
  const parts = host.split('.');
  const tld = parts[parts.length - 1] || '';
  const registered = registrableDomain(host);
  const domainLabel = registered.split('.')[0] || host;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    score += 25; flags.push('Host is a raw IP address');
  }
  if (host.includes('xn--')) {
    score += 20; flags.push('Punycode domain - possible homoglyph attack');
  }
  if (SUSPICIOUS_TLDS.has(tld)) {
    score += 12; flags.push(`Suspicious TLD .${tld}`);
  }

  // Only compare the registrable domain's label, and only when the host is not
  // the brand's own domain.
  for (const b of BRANDS) {
    if (domainLabel === b) break;

    if (domainLabel.length >= 5 && Math.abs(domainLabel.length - b.length) <= 2) {
      const d = levenshtein(domainLabel, b);
      if (d > 0 && d <= 2) {
        score += 18; flags.push(`Domain "${domainLabel}" mimics brand "${b}" (edit distance ${d})`);
        break;
      }
    }
    if (host.includes(b) && !domainLabel.includes(b)) {
      score += 15; flags.push(`Brand "${b}" appears in subdomain but not the registered domain`);
      break;
    }
  }

  // Punycode labels always contain hyphens; only count them for normal hosts.
  if (!host.includes('xn--') && (host.match(/-/g) || []).length >= 3) {
    score += 8; flags.push('Three or more hyphens in hostname');
  }
  if (parts.length >= 5) { score += 8; flags.push('Excessive subdomain depth'); }
  if (finalUrl.length > 120) { score += 6; flags.push('Very long URL'); }
  if (parsed.username) { score += 12; flags.push('"@" in authority - real host may be hidden'); }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    score += 5; flags.push(`Non-standard port ${parsed.port}`);
  }
  if (hops >= 4) { score += 10; flags.push(`Long redirect chain (${hops} hops)`); }
  if (Array.isArray(chain) && chain.some((h) => h && h.via === 'js/meta')) {
    score += 6; flags.push('JS / meta-refresh redirect - harder to inspect statically');
  }

  score = Math.min(score, 100);
  const band = score < 25 ? 'low' : score < 55 ? 'medium' : 'high';

  return {
    score,
    band,
    flags: flags.length ? flags : ['No obvious red flags'],
    host,
    registered_domain: registered,
  };
}

module.exports = { analyze, registrableDomain, levenshtein };
