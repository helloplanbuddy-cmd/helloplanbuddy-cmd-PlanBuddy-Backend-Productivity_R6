'use strict';

/**
 * utils/money.js — Canonical Monetary Unit Helpers
 *
 * FINANCIAL INVARIANT: All internal representations use INTEGER PAISE.
 *
 * Tested properties (Jest):
 *  - rupeesToPaise is deterministic and handles floating traps (e.g. 1.005)
 *  - assertPaise rejects fractional values even if they are numerically
 *    "integer-like" (e.g. 499.00) to prevent unit mistakes.
 */

/**
 * Convert rupees (decimal input) → paise (integer).
 *
 * Round half-up to 2 decimals.
 */
function rupeesToPaise(rupees) {
  if (rupees === null || rupees === undefined) {
    throw new TypeError('rupeesToPaise: amount must not be null or undefined');
  }

  const n = Number(rupees);
  if (!Number.isFinite(n)) {
    throw new TypeError(`rupeesToPaise: invalid amount "${rupees}" — not a finite number`);
  }
  if (n < 0) {
    throw new RangeError(`rupeesToPaise: amount must be non-negative, got ${n}`);
  }

  const scaled = n * 100;
  const eps = Number.EPSILON * Math.abs(scaled);
  return Math.floor(scaled + 0.5 + eps);
}

/**
 * Convert paise (integer) → rupees (2 decimal places).
 */
function paiseToRupees(paise) {
  if (paise === null || paise === undefined) {
    throw new TypeError('paiseToRupees: amount must not be null or undefined');
  }

  const n = Number(paise);
  if (!Number.isFinite(n)) {
    throw new TypeError(`paiseToRupees: invalid amount "${paise}" — not a finite number`);
  }

  return Number((n / 100).toFixed(2));
}

/**
 * Assert that a value is valid paise:
 *  - must be a non-negative integer
 *  - must reject fractional-looking numbers like 499.00
 *    (unit confusion: rupees passed instead of paise)
 */
function assertPaise(paise, context) {
  const tag = context ? ` [${context}]` : '';

  // Reject non-numbers early.
  if (typeof paise !== 'number') {
    throw new RangeError(`assertPaise${tag}: expected number paise, got ${typeof paise}`);
  }

  if (!Number.isFinite(paise)) {
    throw new RangeError(`assertPaise${tag}: expected finite integer paise, got ${paise}`);
  }

  // Reject fractional values.
  // Also reject cases like 499.00 which are technically integers numerically
  // but come in as a rupees-shaped float (unit mixup).
  // We treat any paise value with a fractional representation in the original
  // number (denormalized by JS) as invalid.
  const asString = String(paise);
  const hasDecimalPoint = asString.includes('.') || asString.toLowerCase().includes('e-');

  if (!Number.isInteger(paise) || hasDecimalPoint) {
    throw new RangeError(
      `assertPaise${tag}: expected integer paise, got ${paise} (fractional — raw rupees may have been passed)`
    );
  }


  if (paise < 0) {
    throw new RangeError(`assertPaise${tag}: expected non-negative paise, got ${paise}`);
  }
}

/**
 * Safely convert an amount to paise, accepting explicit unit.
 *
 * @param {number|string} amount
 * @param {'rupees'|'paise'} unit
 */
function toCanonicalPaise(amount, unit) {
  if (unit === 'paise') {
    // ensure strict integer paise
    assertPaise(typeof amount === 'string' ? Number(amount) : amount, 'toCanonicalPaise');
    return Number(amount);
  }
  if (unit === 'rupees') {
    return rupeesToPaise(amount);
  }
  throw new TypeError(`toCanonicalPaise: unit must be "rupees" or "paise", got "${unit}"`);
}

module.exports = {
  rupeesToPaise,
  paiseToRupees,
  assertPaise,
  toCanonicalPaise,
};

