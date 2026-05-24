'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');

// NOTE: This is a minimal implementation to unblock server startup.
// It provides the functions referenced by middleware/routes.

function getJwtSecret() {
  // Prefer explicit secret from env; fall back to generic SECRET.
  return env.JWT_SECRET || env.SECRET || 'dev-secret';
}

function getJwtOptions() {
  // Token expiry isn't critical for health endpoints; keep conservative defaults.
  const expiresIn = env.JWT_EXPIRES_IN || '1h';
  return { expiresIn };
}

function decodeToken(token) {
  // Decoding without verification (used only for safe inspection in some flows)
  return jwt.decode(token);
}

function generateToken(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('generateToken requires a payload object');
  }

  return jwt.sign(payload, getJwtSecret(), getJwtOptions());
}

function verifyToken(token) {
  if (!token) throw new Error('verifyToken: token missing');

  return jwt.verify(token, getJwtSecret());
}

// Revocation helpers: provide stubs that always treat as not revoked.
// If the system expects Redis/DB revocation, it should be wired later.
async function isRevoked(_jti, _db, _redis) {
  return false;
}

function revokeToken(_jti) {
  // no-op stub
}

function revokeAllUserTokens(_userId) {
  // no-op stub
}

module.exports = {
  generateToken,
  verifyToken,
  decodeToken,
  isRevoked,
  revokeToken,
  revokeAllUserTokens,
};

