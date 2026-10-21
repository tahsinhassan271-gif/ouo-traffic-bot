'use strict';

let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

const LOCAL = process.env.USE_LOCAL_CHROMIUM === '1';
let _browser = null;

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--disable-dev-shm-usage',
];

async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;

  const common = { headless: true, args: [...BASE_ARGS, '--no-sandbox'] };

  if (LOCAL) {
    try {
      _browser = await pw.chromium.launch({ ...common, channel: 'chromium' });
    } catch {
      _browser = await pw.chromium.launch(common);
    }
  } else {
    const chromium = require('@sparticuz/chromium');
    chromium.setGraphicsMode = false;
    _browser = await pw.chromium.launch({
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, ...BASE_ARGS],
      headless: true,
    });
  }

  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

module.exports = { getBrowser, closeBrowser };
