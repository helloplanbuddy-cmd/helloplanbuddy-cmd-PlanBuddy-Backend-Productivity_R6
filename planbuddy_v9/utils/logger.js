'use strict';

/**
 * utils/logger.js — Structured Logging with Pino (v1.0)
 *
 * Provides production-grade structured logging with:
 *   • JSON output (parseable by log aggregators)
 *   • Pretty-printing in development
 *   • Configurable log level from env.LOG_LEVEL
 *   • Request correlation support
 *   • Startup/shutdown logging
 */

const pino = require('pino');

// Lazy load env to avoid circular dependencies at module load time
let env = null;

function getEnv() {
  if (!env) {
    env = require('../config/env');
  }
  return env;
}

const logger = pino({
  // Use a getter for level to defer env loading
  get level() {
    return getEnv().LOG_LEVEL || 'info';
  },
  // Pretty printing only in development
  transport: getEnv().IS_DEV ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

module.exports = logger;
