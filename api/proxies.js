'use strict';
const { getProxies } = require('../lib/proxies');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const force = req.query.refresh === '1';
  const list = await getProxies({ force });
  return res.status(200).json({
    count: list.length,
    sample: list.slice(0, 25),
  });
};
