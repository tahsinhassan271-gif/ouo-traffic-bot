'use strict';
const { getBrowser } = require('../lib/browser');

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    await getBrowser();
    return res.status(200).json({ ok: true, ms: Date.now() - t0 });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message), ms: Date.now() - t0 });
  }
};
