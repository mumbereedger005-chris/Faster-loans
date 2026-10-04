'use strict';
// middleware/errorHandler.js — Central error handler
const logger = require('../services/loggerService');

function errorHandler(err, req, res, next) {   // eslint-disable-line no-unused-vars
  // Log full error internally
  logger.error('Unhandled error', {
    message:  err.message,
    stack:    err.stack,
    method:   req.method,
    path:     req.path,
    ip:       req.ip,
    user_id:  req.user?.id,
  });

  // Never leak stack traces to client
  const status  = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'An internal server error occurred. Our team has been notified.'
    : err.message || 'Internal server error.';

  res.status(status).json({ success: false, message });
}

module.exports = errorHandler;
