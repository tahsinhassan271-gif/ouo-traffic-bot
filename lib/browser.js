'use strict';

let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

const LOCAL = process.env.USE_LOCAL_CHROMIUM === '1';
let _browser = null;
let _launching = null;

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-dev-shm-usage',
];

// @sparticuz/chromium ships flags tuned for raw Puppeteer. Playwright manages the
// process model and headless mode itself, so --single-process (which is unstable
// with Playwright and breaks per-context proxies) and its --headless variants are
// stripped out before launching.
function sanitizeArgs(args) {
  return args.filter((a) => a !== '--single-process' && !a.startsWith('--headless'));
}

async function launch() {
  if (LOCAL) {
    return pw.chromium.launch({
      headless: true,
      args: [...BASE_ARGS, '--no-sandbox'],
    });
  }

  const chromium = require('@sparticuz/chromium');
  return pw.chromium.launch({
    executablePath: await chromium.executablePath(),
    args: [...sanitizeArgs(chromium.args), ...BASE_ARGS],
    headless: true,
  });
}

async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;

  // Serialise concurrent cold-start launches (a burst can fire several visits at once).
  if (_launching) return _launching;

  _launching = (async () => {
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
    const b = await launch();
    b.on('disconnected', () => { if (_browser === b) _browser = null; });
    _browser = b;
    return b;
  })();

  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

async function closeBrowser() {
  const b = _browser;
  _browser = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { getBrowser, closeBrowser, sanitizeArgs };
