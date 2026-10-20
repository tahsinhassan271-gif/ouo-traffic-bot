'use strict';

let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

const LOCAL = process.env.USE_LOCAL_CHROMIUM === '1';
let _browser = null;

const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-dev-shm-usage',
];

async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;

  if (LOCAL) {
    _browser = await pw.chromium.launch({
      headless: true,
      args: [...BASE_ARGS, '--no-sandbox'],
    });
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
