'use strict';

const dns = require('dns').promises;
const net = require('net');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp',
];

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    const [a, b] = o;
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a === 169 && b === 254) return false;             // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;    // RFC1918
    if (a === 192 && b === 168) return false;             // RFC1918
    if (a === 192 && b === 0) return false;               // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false;                            // multicast + reserved
    return true;
  }

  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return false;      // unique local
    if (/^fe[89ab][0-9a-f]:/.test(low)) return false;      // link local
    if (low.startsWith('::ffff:')) return isPublicIp(low.slice(7));
    return true;
  }

  return false;
}

/**
 * Parse and vet a user-supplied URL before the server fetches it.
 * Blocks non-HTTP schemes, loopback/private/link-local targets and hostnames
 * that resolve to private addresses (cloud metadata endpoints, internal DNS).
 *
 * Throws an Error with a user-safe message when the URL is not allowed.
 */
async function assertPublicHttpUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch {
    throw new Error('Invalid URL');
  }

  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs are allowed');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Invalid URL');

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error('Refusing to fetch an internal host');
  }

  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error('Refusing to fetch a private or reserved IP address');
    return u;
  }

  // A name can resolve to a private address even when the name looks harmless,
  // so resolve first. Lookup failures fall through - fetch will fail anyway.
  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    if (addrs.some((a) => !isPublicIp(a.address))) {
      throw new Error('Refusing to fetch a host that resolves to a private address');
    }
  } catch (e) {
    if (/^Refusing/.test(String(e && e.message))) throw e;
  }

  return u;
}

module.exports = { assertPublicHttpUrl, isPublicIp };
