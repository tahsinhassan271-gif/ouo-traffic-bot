'use strict';
const crypto = require('crypto');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Optional hardening for the browser-facing endpoints.
 * Set ACCESS_TOKEN and the dashboard will ask for it once and store it locally.
 */
function checkAccess(req) {
  const token = process.env.ACCESS_TOKEN;
  if (!token) return true;

  const header = req.headers && req.headers['x-access-token'];
  const query = req.query && req.query.token;
  const given = header || query;
  return Boolean(given) && safeEqual(given, token);
}

/**
 * Protects /api/cron. Vercel Cron automatically sends
 * `Authorization: Bearer $CRON_SECRET`, so setting that env var is enough.
 */
function checkCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const headers = req.headers || {};
  const auth = String(headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && safeEqual(bearer[1].trim(), secret)) return true;

  const given = headers['x-cron-secret'] || (req.query && req.query.secret);
  return Boolean(given) && safeEqual(given, secret);
}

function denied(res, error = 'Unauthorized') {
  return res.status(401).json({ success: false, error });
}

module.exports = { checkAccess, checkCron, denied };
