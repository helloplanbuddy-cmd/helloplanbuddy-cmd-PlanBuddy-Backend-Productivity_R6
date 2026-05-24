'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');

const INTERNAL_ALLOWED_IPS = env.INTERNAL_ALLOWED_IPS;

function isAllowedInternalIP(ip) {
  return INTERNAL_ALLOWED_IPS.includes(ip);
}

function internalIpGuard(req, res, next) {
  const clientIp = req.ip || req.socket.remoteAddress;

  if (!isAllowedInternalIP(clientIp)) {
    logger.warn({ requestId: req.requestId, ip: clientIp, path: req.path }, '[internal] Access denied to internal observability route');
    return res.status(403).json({
      success: false,
      code: 'INTERNAL_ACCESS_DENIED',
      message: 'Access to internal observability routes is restricted.',
    });
  }

  next();
}

module.exports = internalIpGuard;
