'use strict';
const store = require('../lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const stats = await store.getStats();
  const log = await store.getLog(25);
  return res.status(200).json({
    ...stats,
    estimatedUsd: Number(((stats.views / 1000) * 1.5).toFixed(4)),
    log,
  });
};
