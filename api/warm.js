'use strict';
const { getBrowser, summarizeError, diagnostics } = require('../lib/browser');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  try {
    await getBrowser();
    return res.status(200).json({ ok: true, ms: Date.now() - t0, runtime: diagnostics() });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: summarizeError(e),
      ms: Date.now() - t0,
      runtime: diagnostics(),
    });
  }
};
