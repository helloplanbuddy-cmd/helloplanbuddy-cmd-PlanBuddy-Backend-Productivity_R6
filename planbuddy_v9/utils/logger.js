'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const pino = require('pino');

// Lazy load env to avoid circular dependencies at module load time
let env = null;
function getEnv() {
  if (!env) {
    env = require('../config/env');
  }
  return env;
}

const requestContext = new AsyncLocalStorage();
function getBindings() {
  return requestContext.getStore() || {};
}

const baseLogger = pino({
  get level() {
    return getEnv().LOG_LEVEL || 'info';
  },
  transport: getEnv().IS_DEV ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
});

function setBindings(fields) {
  const current = getBindings();
  requestContext.enterWith({ ...current, ...fields });
}

function getLogger() {
  const bindings = getBindings();
  if (Object.keys(bindings).length === 0) {
    return baseLogger;
  }
  return baseLogger.child(bindings);
}

const logger = new Proxy(baseLogger, {
  get(target, prop) {
    if (prop === 'setBindings') return setBindings;
    if (prop === 'getLogger') return getLogger;

    const currentLogger = getLogger();
    const value = currentLogger[prop];
    if (typeof value === 'function') {
      return value.bind(currentLogger);
    }
    return value;
  },
});

module.exports = logger;
