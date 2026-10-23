'use strict';
/* lib/browser.js — single shared browser, launched once. */

let _browser = null;
let _launching = null;

function chromiumFrom() {
  try { return require('playwright').chromium; }
  catch (_) { return require('playwright-core').chromium; }
}

async function launch() {
  const chromium = chromiumFrom();
  const local = process.env.USE_LOCAL_CHROMIUM === '1' || !process.env.VERCEL;

  if (local) {
    console.log('[browser] local full chromium');
    return chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--no-first-run',
      ],
    });
  }

  const sparticuz = require('@sparticuz/chromium');
  console.log('[browser] serverless chromium');
  return chromium.launch({
    args: sparticuz.args,
    executablePath: await sparticuz.executablePath(),
    headless: true,
  });
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  _launching = launch()
    .then(b => { _browser = b; _launching = null; return b; })
    .catch(e => { _launching = null; throw e; });
  return _launching;
}

async function closeBrowser() {
  try { if (_browser) await _browser.close(); } catch (_) {}
  _browser = null;
}

module.exports = { getBrowser, closeBrowser };
