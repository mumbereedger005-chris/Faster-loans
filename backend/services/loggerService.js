'use strict';
// services/loggerService.js — Winston logger with EAT timestamps
process.env.TZ = 'Africa/Kampala';
const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const eatTimestamp = format((info) => {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  info.timestamp = eat.toISOString().replace('T', ' ').substring(0, 19) + ' EAT';
  return info;
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    eatTimestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        eatTimestamp(),
        format.colorize(),
        format.printf(({ timestamp, level, message, stack }) =>
          `[${timestamp}] ${level}: ${stack || message}`)
      ),
    }),
    new transports.File({
      filename: path.join(logDir, 'error.log'),
      level:    'error',
      maxsize:  10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize:  20 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

module.exports = logger;
