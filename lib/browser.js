'use strict';

const fs = require('fs');
const path = require('path');

let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

const LOCAL = process.env.USE_LOCAL_CHROMIUM === '1';
let _browser = null;
let _launching = null;
let _libPath = null;

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

function chromiumRoot() {
  return path.dirname(require.resolve('@sparticuz/chromium/package.json'));
}

/**
 * Turn a Playwright launch failure into something readable.
 *
 * Playwright prints the entire <launching> argv (hundreds of chars) before the
 * line that actually explains the failure, so slicing the message produced notes
 * that always stopped at the same useless place.
 */
function summarizeError(e) {
  const raw = String((e && e.message) || e);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const key = lines.filter((l) =>
    /\[err\]|exitCode=|error while loading shared libraries|Killed|out of memory|ENOMEM|Failed to launch|No such file|ENOENT/i.test(l));

  if (key.length) {
    const joined = key.slice(-2).join(' | ');
    return joined.length > 300 ? joined.slice(0, 300) + '...' : joined;
  }

  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= 240) return flat;
  return `${flat.slice(0, 120)} ... ${flat.slice(-120)}`;
}

/**
 * Vercel does not look like AWS Lambda to @sparticuz/chromium, so it never
 * extracts bin/al2023.tar.br nor puts those libs on the loader path. Chromium
 * then dies with exit code 127 ("libnss3.so: cannot open shared object file")
 * and Playwright only reports "Target page, context or browser has been
 * closed" - which is what the dashboard was showing.
 *
 * Extract the libraries ourselves and extend LD_LIBRARY_PATH. Verified to turn
 * a hard 127 into a working browser on a machine with no system libnss3.
 */
async function ensureServerlessLibs() {
  if (_libPath) return _libPath;

  const root = chromiumRoot();
  // AL2023 first: Vercel's Node runtime is Amazon Linux 2023.
  for (const name of ['al2023', 'al2']) {
    const tar = path.join(root, 'bin', `${name}.tar.br`);
    if (!fs.existsSync(tar)) continue;

    const libPath = path.join('/tmp', name, 'lib');
    if (!fs.existsSync(libPath)) {
      try {
        const mod = require(path.join(root, 'build', 'lambdafs'));
        const lambdafs = mod.default || mod;
        await lambdafs.inflate(tar);
      } catch (e) {
        // Fall through to the next candidate; summarise later if none work.
        continue;
      }
    }
    if (!fs.existsSync(libPath)) continue;

    const parts = String(process.env.LD_LIBRARY_PATH || '').split(':').filter(Boolean);
    if (!parts.includes(libPath)) parts.unshift(libPath);
    process.env.LD_LIBRARY_PATH = parts.join(':');
    process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || '/tmp/fonts';

    _libPath = libPath;
    return _libPath;
  }

  return null;
}

async function launch() {
  if (LOCAL) {
    // GitHub Actions: playwright install --with-deps provides system libs.
    return pw.chromium.launch({
      headless: true,
      args: [...BASE_ARGS, '--no-sandbox'],
    });
  }

  const chromium = require('@sparticuz/chromium');
  const executablePath = await chromium.executablePath();
  await ensureServerlessLibs();

  return pw.chromium.launch({
    executablePath,
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

/** Facts about this runtime, for /api/warm and debugging deployments. */
function diagnostics() {
  const info = {
    mode: LOCAL ? 'local' : 'serverless',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ldLibraryPath: process.env.LD_LIBRARY_PATH || null,
    libsPath: _libPath,
    libsPresent: Boolean(_libPath && fs.existsSync(_libPath)),
    executablePath: null,
    executablePresent: false,
  };

  if (!LOCAL) {
    try {
      const bin = path.join(chromiumRoot(), 'bin');
      info.bundleFiles = fs.existsSync(bin) ? fs.readdirSync(bin) : [];
      info.executablePath = fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : null;
      info.executablePresent = Boolean(info.executablePath);
    } catch { /* ignore */ }
  }

  return info;
}

module.exports = { getBrowser, closeBrowser, sanitizeArgs, summarizeError, ensureServerlessLibs, diagnostics };
