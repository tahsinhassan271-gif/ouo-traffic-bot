'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { analyze, registrableDomain } = require('../lib/phish');
const { parseProxy } = require('../lib/proxies');
const { assertPublicHttpUrl, isPublicIp } = require('../lib/urlsafe');
const { sanitizeArgs } = require('../lib/browser');

test('registrableDomain handles multi-part public suffixes', () => {
  assert.equal(registrableDomain('apple.co.uk'), 'apple.co.uk');
  assert.equal(registrableDomain('mail.apple.co.uk'), 'apple.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('172.16.0.9'), '172.16.0.9');
});

test('legit ccTLD domain is not flagged as a brand look-alike', () => {
  const r = analyze('https://apple.co.uk');
  assert.equal(r.registered_domain, 'apple.co.uk');
  assert.equal(r.flags.includes('No obvious red flags'), true);
});

test('brand hidden in a subdomain is still flagged', () => {
  const r = analyze('https://paypal.com.secure-login.tk/x');
  assert.equal(r.registered_domain, 'secure-login.tk');
  assert.ok(r.score >= 25);
  assert.ok(r.flags.some((f) => f.includes('paypal')));
});

test('js/meta redirects are detected from the chain via field', () => {
  const r = analyze('https://a.tk', 5, [{ via: 'js/meta' }]);
  assert.ok(r.flags.some((f) => f.includes('meta-refresh')));
  assert.ok(r.flags.some((f) => f.includes('Long redirect chain')));
});

test('junk, private and out-of-range proxies are rejected', () => {
  assert.equal(parseProxy('999.999.999.999:8080'), null);
  assert.equal(parseProxy('10.0.0.1:3128'), null);
  assert.equal(parseProxy('192.168.1.1:80'), null);
  assert.equal(parseProxy('127.0.0.1:80'), null);
  assert.equal(parseProxy('169.254.169.254:80'), null);
  assert.equal(parseProxy('8.8.8.8:70000'), null);
  assert.equal(parseProxy('0.0.0.0:80'), null);
  assert.equal(parseProxy('8.8.8.8'), null);
});

test('valid proxies are normalised', () => {
  assert.deepEqual(parseProxy(' 5.6.7.8:3128 '), {
    scheme: 'http', host: '5.6.7.8', port: 3128, url: 'http://5.6.7.8:3128',
  });
  assert.equal(parseProxy('socks5://8.8.8.8:1080').url, 'socks5://8.8.8.8:1080');
});

test('private and reserved IP ranges are not public', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('192.168.1.1'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('::ffff:10.0.0.1'), false);
  assert.equal(isPublicIp('2001:4860:4860::8888'), true);
});

test('SSRF guard blocks internal targets and non-http schemes', async () => {
  const blocked = [
    'http://127.0.0.1/a',
    'http://localhost:3000',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ];
  for (const u of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(u), undefined, `expected ${u} to be blocked`);
  }

  const ok = await assertPublicHttpUrl('https://example.com/path');
  assert.equal(ok.protocol, 'https:');
});

test('playwright-incompatible chromium flags are stripped', () => {
  const args = sanitizeArgs(['--no-sandbox', '--single-process', "--headless='shell'", '--headless']);
  assert.deepEqual(args, ['--no-sandbox']);
});
