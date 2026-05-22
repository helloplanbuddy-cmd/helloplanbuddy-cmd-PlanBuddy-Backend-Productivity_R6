'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

function traceIdMiddleware(req, res, next) {
  // Extract existing trace/correlation ID or generate new one
  const traceId =
    req.headers['x-trace-id'] ||
    req.headers['x-correlation-id'] ||
    req.requestId ||
    crypto.randomUUID();

  // Attach to request object for use in all routes/services
  req.traceId = traceId;
  req.correlationId = traceId; // Alias for consistency
  req.startTime = Date.now();
  
  // Add to response headers
  res.setHeader('X-Trace-Id', traceId);
  res.setHeader('X-Correlation-ID', traceId);
  
  // Bind trace ID to all logger calls for this request
  if (logger.setBindings) {
    logger.setBindings({ traceId, correlationId: traceId });
  }
  
  logger.info(
    { method: req.method, path: req.path, ip: req.ip, traceId },
    '[traceId] New request started'
  );
  
  // Log when request completes with duration
  res.on('finish', () => {
    logger.info(
      { 
        method: req.method, 
        path: req.path, 
        statusCode: res.statusCode,
        duration: Date.now() - req.startTime,
        traceId
      },
      '[traceId] Request completed'
    );
  });
  
  next();
}

function updateTraceContext(fields) {
  // Update logger context with additional trace fields
  if (logger.setBindings) {
    logger.setBindings(fields);
  }
}

module.exports = { traceIdMiddleware, updateTraceContext };