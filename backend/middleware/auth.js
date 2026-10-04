'use strict';
// middleware/auth.js — JWT access-token verification
const jwt    = require('jsonwebtoken');
const db     = require('../db/db');
const logger = require('../services/loggerService');

/**
 * Verify Bearer JWT.  Attaches req.user = { id, uuid, role, email }.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Access token required.' });
    }
    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      const msg = e.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid token.';
      return res.status(401).json({ success: false, message: msg });
    }

    // Load user from DB to ensure still active
    const [rows] = await db.execute(
      'SELECT id, uuid, role, email, first_name, last_name, is_active FROM users WHERE id = ?',
      [payload.sub]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Account not found or inactive.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    logger.error('auth middleware error', { error: err.message });
    next(err);
  }
}

module.exports = { authenticate };
