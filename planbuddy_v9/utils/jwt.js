'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function getJwtSecret() {
  return env.JWT_SECRET || env.SECRET || 'dev-secret';
}

function getJwtExpiration() {
  return env.JWT_EXPIRY || env.JWT_EXPIRES_IN || '1h';
}

function parseDurationToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }

  if (typeof value !== 'string') {
    return 3600;
  }

  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    return 3600;
  }

  const amount = Number(match[1]);
  const unit = match[2] || 's';

  switch (unit) {
    case 'ms': return Math.max(1, Math.ceil(amount / 1000));
    case 's': return amount;
    case 'm': return amount * 60;
    case 'h': return amount * 60 * 60;
    case 'd': return amount * 24 * 60 * 60;
    default: return amount;
  }
}

function getJwtOptions() {
  return { expiresIn: getJwtExpiration() };
}

function decodeToken(token) {
  return jwt.decode(token);
}

function generateToken(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('generateToken requires a payload object');
  }

  const tokenPayload = { ...payload };
  if (payload.id && !payload.sub) {
    tokenPayload.sub = payload.id;
  }

  const jti = crypto.randomUUID();
  const token = jwt.sign(tokenPayload, getJwtSecret(), {
    ...getJwtOptions(),
    jwtid: jti,
    algorithm: 'HS256',
  });

  return { token, jti };
}

function verifyToken(token) {
  if (!token) throw new Error('verifyToken: token missing');
  return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
}

function getBlacklistCacheKey(jti) {
  return `jwt:blacklist:${jti}`;
}

function getUserRevocationCacheKey(userId) {
  return `jwt:revoked_all:${userId}`;
}

async function isRevoked(jti, userId, iat, db, redis) {
  if (!jti) return false;

  const cacheKey = getBlacklistCacheKey(jti);

  if (redis && redis.status === 'ready') {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return true;
    } catch (_) {
      // ignore cache failures
    }
  }

  if (userId && redis && redis.status === 'ready') {
    try {
      const revokedAll = await redis.get(getUserRevocationCacheKey(userId));
      if (revokedAll) {
        const revokedAt = Number(revokedAll);
        if (Number.isFinite(revokedAt)) {
          if (typeof iat === 'number' && revokedAt >= iat * 1000) {
            return true;
          }
        } else {
          return true;
        }

        if (typeof iat !== 'number') {
          return true;
        }
      }
    } catch (_) {
      // ignore cache failures
    }
  }

  if (!db) return false;

  try {
    const result = await db.query(
      `SELECT jti FROM token_blacklist WHERE jti = $1 LIMIT 1`,
      [jti]
    );

    if (result.rows.length > 0) {
      return true;
    }

    if (userId) {
      if (typeof iat === 'number') {
        const marker = await db.query(
          `SELECT 1 FROM token_blacklist
             WHERE user_id = $1
               AND jti LIKE 'revoke_all_%'
               AND created_at > TO_TIMESTAMP($2)
             LIMIT 1`,
          [userId, iat]
        );

        if (marker.rows.length > 0) {
          return true;
        }
      } else {
        const marker = await db.query(
          `SELECT 1 FROM token_blacklist
             WHERE user_id = $1
               AND jti LIKE 'revoke_all_%'
             LIMIT 1`,
          [userId]
        );

        if (marker.rows.length > 0) {
          return true;
        }
      }
    }
  } catch (_) {
    // ignore DB errors for revocation check
  }

  return false;
}

async function revokeToken(jti, userId, db, redis, { expiresAt } = {}) {
  if (!jti || !userId) return;

  const ttlSeconds = expiresAt
    ? Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : parseDurationToSeconds(getJwtExpiration());

  const expiresAtDate = expiresAt
    ? new Date(expiresAt)
    : new Date(Date.now() + ttlSeconds * 1000);

  if (db) {
    try {
      await db.query(
        `INSERT INTO token_blacklist (jti, user_id, expires_at)
           VALUES ($1, $2, $3)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, userId, expiresAtDate]
      );
    } catch (_) {
      // best effort
    }
  }

  if (redis && redis.status === 'ready' && ttlSeconds > 0) {
    try {
      await redis.set(getBlacklistCacheKey(jti), '1', 'EX', ttlSeconds);
    } catch (_) {
      // best effort
    }
  }
}

async function revokeAllUserTokens(userId, db, redis, { expiresAt } = {}) {
  if (!userId) return;

  const ttlSeconds = expiresAt
    ? Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : parseDurationToSeconds(getJwtExpiration());

  const expiresAtDate = expiresAt
    ? new Date(expiresAt)
    : new Date(Date.now() + ttlSeconds * 1000);

  if (redis && redis.status === 'ready') {
    try {
      await redis.set(getUserRevocationCacheKey(userId), String(Date.now()), 'EX', ttlSeconds);
    } catch (_) {
      // best effort
    }
  }

  if (db) {
    const markerJti = `revoke_all_${crypto.randomBytes(12).toString('hex')}`;
    try {
      await db.query(
        `INSERT INTO token_blacklist (jti, user_id, expires_at)
           VALUES ($1, $2, $3)
         ON CONFLICT (jti) DO NOTHING`,
        [markerJti, userId, expiresAtDate]
      );
    } catch (_) {
      // best effort
    }
  }
}

module.exports = {
  generateToken,
  verifyToken,
  decodeToken,
  isRevoked,
  revokeToken,
  revokeAllUserTokens,
};

