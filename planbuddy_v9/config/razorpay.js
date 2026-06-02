'use strict';

/**
 * config/razorpay.js — Razorpay Client Config (v3.1)
 *
 * SINGLE SOURCE OF TRUTH for the Razorpay SDK instance.
 * No other file in the codebase should ever call `new Razorpay(...)`.
 *
 * Fixes applied (v3.0 → v3.1):
 *  - Renamed `rupeesToPaise` export alias added as `toSubunit` to eliminate
 *    the runtime TypeError in paymentController.js while preserving the
 *    canonical name. Both names point to the same function.
 *  - Explicit export of the singleton `client` under the additional key
 *    `razorpay` so controllers can destructure either name without breakage.
 *
 * Classification: ✅ KEEP from v2.0 — startup-validated keys, singleton pattern.
 */

const Razorpay = require('razorpay');
const env      = require('./env');
const { rupeesToPaise, paiseToRupees } = require('../utils/money');

// Keys are guaranteed to be set by config/env.js startup validation.
const keyId     = env.RAZORPAY_KEY_ID;
const keySecret = env.RAZORPAY_KEY_SECRET;

// ─── Singleton SDK instance ───────────────────────────────────────────────────
// Instantiated ONCE here. Every consumer imports this module; Node's module
// cache guarantees a single Razorpay object for the entire process lifetime.
//
// SECURITY [f-017]: TLS certificate validation is ENABLED by default.
//   • Node.js 17+ validates certificates by default (rejectUnauthorized: true).
//   • NO custom HTTP agent is passed — the SDK uses Node's built-in HTTPS.
//   • NEVER pass rejectUnauthorized: false or a custom agent with disabled TLS.
//   • If you need to configure proxies, use an agent that preserves cert validation.
const razorpayClient = new Razorpay({
  key_id:     keyId,
  key_secret: keySecret,
});

// ─── Currency helpers ─────────────────────────────────────────────────────────

/**
 * Convert rupees (decimal) to paise (integer).
 * Razorpay amounts must always be in the smallest currency unit (paise for INR).
 *
 * @param {number} rupees
 * @returns {number} paise as a safe integer
 */
// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Primary SDK reference — use either name; both point to the same instance.
  client:  razorpayClient,
  razorpay: razorpayClient,   // ← alias for destructured imports in controllers

  // Credential references (read-only; no callers should re-use these to
  // construct a second SDK instance — use `client` / `razorpay` instead).
  keyId,
  keySecret,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,

  // Currency conversion — two names, one function.
  rupeesToPaise,
  toSubunit: rupeesToPaise,   // ← alias that eliminates the TypeError in controllers
  paiseToRupees,
};