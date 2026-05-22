'use strict';

/**
 * middleware/proxyValidation.js — X-Forwarded-For & Proxy Header Validation (v1.0)
 *
 * SECURITY FIX for Phase -1: X-Forwarded-For Spoofing
 *
 * Problem:
 *   With `app.set('trust proxy', 1)`, Express trusts X-Forwarded-For headers.
 *   If attacker can make direct TCP connection (bypassing LB), they can:
 *     • Spoof client IP per request
 *     • Rotate through many IPs
 *     • Bypass per-IP rate limiters
 *     • Evade IP-based bans
 *
 * Solution:
 *   Validate X-Forwarded-For comes ONLY from known proxy IPs.
 *   If request comes from unknown IP claiming to be proxied:
 *     • Strip X-Forwarded-For header
 *     • Use real source IP (direct connection)
 *     • Log suspected spoofing attempt
 *
 * Usage:
 *   app.use(proxyValidation.middleware());
 *   Deployed after trust proxy, before rate limiting
 *
 * Infrastructure requirements:
 *   • All production traffic must come through proxy/LB
 *   • Configure KNOWN_PROXY_IPS with your load balancer's IP range
 *   • Firewall: block direct connections to app port (except from LB)
 */

const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Get list of known proxy IP addresses/ranges
 * In production, load from environment or config
 */
function getKnownProxyIPs() {
  // For development: allow localhost and local network
  if (env.IS_DEV) {
    return [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'localhost',
      // Local Docker network
      '172.17.0.0/16',
      '172.18.0.0/16',
      '172.19.0.0/16',
      '172.20.0.0/16',
      '172.21.0.0/16',
    ];
  }

  // For production: configure known load balancer IPs
  // Example:
  //   - Render.com: specific IPs
  //   - Railway: specific IPs
  //   - AWS ALB: specific IPs or security group
  //   - Azure: specific IPs or service tags
  //   - Nginx: local network (docker/k8s)
  //
  // Set KNOWN_PROXY_IPS environment variable as comma-separated list
  const envProxies = process.env.KNOWN_PROXY_IPS;
  if (envProxies) {
    return envProxies.split(',').map(ip => ip.trim());
  }

  // Fallback: only allow localhost (very restrictive)
  logger.warn(
    '[proxy-validation] KNOWN_PROXY_IPS not configured in production. ' +
    'X-Forwarded-For validation disabled. Set KNOWN_PROXY_IPS env var.'
  );
  return [];
}

/**
 * Check if IP is in allowed list
 * Supports CIDR notation for ranges
 */
function isAllowedProxy(ip) {
  const allowed = getKnownProxyIPs();

  for (const allowed_ip of allowed) {
    // Exact match
    if (ip === allowed_ip) return true;

    // CIDR range match (simplified: IPv4 only)
    if (allowed_ip.includes('/')) {
      const [base, prefix] = allowed_ip.split('/');
      const baseNum = ipToNumber(base);
      const testNum = ipToNumber(ip);

      if (baseNum === null || testNum === null) continue;

      const prefixLen = parseInt(prefix, 10);
      const mask = (0xffffffff << (32 - prefixLen)) >>> 0;

      if ((baseNum & mask) === (testNum & mask)) return true;
    }
  }

  return false;
}

/**
 * Convert IPv4 string to 32-bit number
 */
function ipToNumber(ip) {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  const [, a, b, c, d] = match;
  return (parseInt(a, 10) << 24 | parseInt(b, 10) << 16 | parseInt(c, 10) << 8 | parseInt(d, 10)) >>> 0;
}

/**
 * Main validation middleware
 */
function middleware() {
  return (req, res, next) => {
    const realSourceIP = req.socket.remoteAddress;
    const xForwardedFor = req.headers['x-forwarded-for'];

    // If no X-Forwarded-For header, no spoofing risk
    if (!xForwardedFor) {
      return next();
    }

    // If real source IP is an allowed proxy, trust the X-Forwarded-For
    if (isAllowedProxy(realSourceIP)) {
      // Valid proxy chain, keep the header
      return next();
    }

    // SECURITY ISSUE: Non-proxy claiming to be behind proxy!
    logger.warn(
      {
        realSourceIP,
        xForwardedFor,
        path: req.path,
        method: req.method,
      },
      '[proxy-validation] Suspicious X-Forwarded-For from non-proxy source (spoofing attempt?)'
    );

    // Strip X-Forwarded-For header to prevent spoofing
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-host'];

    // Express will now use real source IP
    next();
  };
}

module.exports = {
  middleware,
  isAllowedProxy,
};
