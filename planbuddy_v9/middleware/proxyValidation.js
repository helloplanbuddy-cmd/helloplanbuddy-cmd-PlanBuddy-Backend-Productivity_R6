'use strict';

const net = require('net');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * middleware/proxyValidation.js — X-Forwarded-For & Proxy Header Validation (v1.1)
 *
 * SECURITY FIX: Validate X-Forwarded-For only when the source IP is a known proxy.
 * When an unknown IP submits proxy headers, they are stripped to prevent
 * client-side spoofing of rate limiting and request attribution.
 */

function getKnownProxyIPs() {
  if (env.IS_DEV) {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
  }

  return env.KNOWN_PROXY_IPS || [];
}

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function ipToNumber(ip) {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  const [, a, b, c, d] = match;
  return (parseInt(a, 10) << 24 | parseInt(b, 10) << 16 | parseInt(c, 10) << 8 | parseInt(d, 10)) >>> 0;
}

function cidrContains(ip, cidr) {
  const [base, prefix] = cidr.split('/');
  if (!base || !prefix) return false;

  const normalizedIp = normalizeIp(ip);
  const normalizedBase = normalizeIp(base);

  if (net.isIP(normalizedIp) !== 4 || net.isIP(normalizedBase) !== 4) {
    return false;
  }

  const ipNum = ipToNumber(normalizedIp);
  const baseNum = ipToNumber(normalizedBase);
  if (ipNum === null || baseNum === null) return false;

  const prefixLen = parseInt(prefix, 10);
  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function isAllowedProxy(sourceIp) {
  const normalizedIp = normalizeIp(sourceIp);
  if (!normalizedIp || net.isIP(normalizedIp) === 0) {
    return false;
  }

  const allowed = getKnownProxyIPs();
  for (const entry of allowed) {
    const normalizedEntry = normalizeIp(entry);
    if (normalizedEntry === normalizedIp) {
      return true;
    }

    if (normalizedEntry.includes('/')) {
      if (cidrContains(normalizedIp, normalizedEntry)) {
        return true;
      }
    }
  }

  return false;
}

function middleware() {
  return (req, res, next) => {
    const realSourceIP = req.socket.remoteAddress;
    const xForwardedFor = req.headers['x-forwarded-for'];

    if (!xForwardedFor) {
      return next();
    }

    if (isAllowedProxy(realSourceIP)) {
      return next();
    }

    logger.warn(
      {
        realSourceIP,
        xForwardedFor,
        path: req.path,
        method: req.method,
      },
      '[proxy-validation] stripping untrusted X-Forwarded-For header from unknown source'
    );

    delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-host'];

    next();
  };
}

module.exports = {
  middleware,
  isAllowedProxy,
};
