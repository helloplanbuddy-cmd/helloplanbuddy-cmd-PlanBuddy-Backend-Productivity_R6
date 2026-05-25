'use strict';

/**
 * middleware/csrfProtection.js — CSRF Protection for SPA-Only Architecture (v1.0)
 *
 * SECURITY MODEL: SPA-Only
 * This API is designed for single-page application (SPA) clients. CSRF protection
 * relies on:
 *
 *  1. CORS origin validation (app.js) — only whitelisted origins can make requests
 *  2. SameSite=Strict cookies (if using session cookies for non-JWT endpoints)
 *  3. X-Requested-With header validation — only XMLHttpRequest / fetch can proceed
 *
 * Why SPA-only is safe:
 *  - Browsers enforce SOP (same-origin policy) on resources
 *  - Forms cannot set X-Requested-With header (browser security)
 *  - Cross-origin form submission is blocked by CORS
 *  - Attacker cannot forge SPA requests from malicious page
 *
 * If you need to support:
 *  - Traditional form submissions (non-SPA)
 *  - WebView clients (mobile apps without SPA)
 *  - Third-party integrations
 *  Then implement explicit CSRF tokens (see below).
 */

const logger = require('../utils/logger');
const env    = require('../config/env');

const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Validate X-Requested-With header on state-changing requests.
 * This header is set by XMLHttpRequest / fetch (SPA) but CANNOT be
 * set by browser form submissions (CSRF vectors).
 *
 * SPA clients MUST set: X-Requested-With: XMLHttpRequest
 */
function csrfProtection(req, res, next) {
  // State-changing methods require CSRF validation
  if (!CSRF_SAFE_METHODS.includes(req.method)) {
    const xRequestedWith = req.headers['x-requested-with'];

    // In production, enforce strict CSRF validation
    if (env.IS_PROD && !xRequestedWith) {
      logger.warn({
        requestId: req.requestId,
        ip: req.ip,
        path: req.path,
        method: req.method,
      }, '[csrf] Rejected state-changing request without X-Requested-With header');

      return res.status(403).json({
        success: false,
        code: 'CSRF_VALIDATION_FAILED',
        message: 'CSRF validation failed. API is SPA-only. Clients must set X-Requested-With: XMLHttpRequest header.',
      });
    }

    // In development, log but allow (for testing via curl, Postman)
    if (!xRequestedWith) {
      logger.info({
        requestId: req.requestId,
        path: req.path,
        method: req.method,
      }, '[csrf] Development mode: allowing state-change without X-Requested-With header');
    }
  }

  next();
}

module.exports = csrfProtection;
