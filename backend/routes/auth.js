'use strict';
// routes/auth.js — Register, Login, Logout, Refresh, OTP, Password Reset
process.env.TZ = 'Africa/Kampala';
const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit    = require('express-rate-limit');
const { body }     = require('express-validator');

const db           = require('../db/db');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { writeAudit }   = require('../middleware/auditLog');
const notif        = require('../services/notificationService');
const { encrypt }  = require('../compliance/dataProtection');
const logger       = require('../services/loggerService');

const router = express.Router();

// Strict rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  message: { success: false, message: 'Too many attempts. Please wait 15 minutes.' },
});

// ── Helpers ──────────────────────────────────────────────────────
function eatNow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}
function eatStr(d) {
  return (d || eatNow()).toISOString().replace('T', ' ').substring(0, 19);
}

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, uuid: user.uuid, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}
function signRefresh(user) {
  return jwt.sign(
    { sub: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function makeOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function generateRef() {
  const now = eatNow();
  const year = now.getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `FL-${year}-${rand}`;
}

// ── POST /api/auth/register ──────────────────────────────────────
router.post('/register', authLimiter, [
  body('first_name').trim().notEmpty().withMessage('First name required'),
  body('last_name').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone').trim().matches(/^(\+256|0)[0-9]{9}$/).withMessage('Valid Uganda phone required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
  body('national_id').optional().trim(),
  body('district').optional().trim(),
], validate, async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { first_name, last_name, email, phone, password, national_id, district, address } = req.body;

    // Check duplicates
    const [exist] = await conn.execute(
      'SELECT id FROM users WHERE email = ? OR phone = ?', [email, phone]
    );
    if (exist.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Email or phone already registered.' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const uuid = uuidv4();
    const now  = eatStr();

    const [result] = await conn.execute(
      `INSERT INTO users
         (uuid, role, first_name, last_name, email, phone, password_hash,
          national_id, district, address, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid, 'customer', first_name, last_name, email, phone,
       password_hash, national_id || null, district || null, address || null, now, now]
    );
    const userId = result.insertId;

    // Record consents
    const consentTypes = ['data_processing', 'terms', 'credit_check'];
    for (const ct of consentTypes) {
      await conn.execute(
        `INSERT INTO consent_records (user_id, consent_type, granted, version, ip_address, user_agent, granted_at)
         VALUES (?,?,1,?,?,?,?)`,
        [userId, ct, process.env.TERMS_VERSION || '1.0', req.ip,
         req.headers['user-agent'] || '', now]
      );
    }

    // Send OTP for phone verification
    const otp = makeOTP();
    const otpHash = hashToken(otp);
    const otpExpiry = eatStr(new Date(Date.now() + 3 * 60 * 60 * 1000 + 10 * 60 * 1000));
    await conn.execute(
      `INSERT INTO otp_tokens (user_id, token_hash, purpose, expires_at, created_at)
       VALUES (?,?,'verify_phone',?,?)`,
      [userId, otpHash, otpExpiry, now]
    );

    await conn.commit();

    // Notifications (non-blocking)
    notif.sendSMS(phone,
      `Welcome to Faster Loans Uganda! Your verification code is ${otp}. Valid for 10 minutes. Do not share this code.`
    ).catch(() => {});
    notif.sendEmail(email, 'Welcome to Faster Loans Uganda', 'welcome', {
      name: first_name, otp, company: process.env.COMPANY_NAME,
    }).catch(() => {});

    writeAudit({ actorId: userId, actorRole: 'customer', action: 'user.registered',
      entity: 'users', entityId: userId, newValues: { email, phone }, ipAddress: req.ip });

    logger.info(`New registration: ${email} at ${now} (EAT)`);

    res.status(201).json({
      success: true,
      message: 'Registration successful. Please verify your phone with the OTP sent via SMS.',
      user_id: userId,
      applied_at_eat: now,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ── POST /api/auth/verify-otp ────────────────────────────────────
router.post('/verify-otp', authLimiter, [
  body('user_id').isInt().withMessage('user_id required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('6-digit OTP required'),
  body('purpose').optional().isIn(['verify_phone','verify_email','reset_password','login_2fa']),
], validate, async (req, res, next) => {
  try {
    const { user_id, otp, purpose = 'verify_phone' } = req.body;
    const otpHash = hashToken(otp);
    const now = eatStr();

    const [rows] = await db.execute(
      `SELECT id, expires_at, used FROM otp_tokens
       WHERE user_id = ? AND token_hash = ? AND purpose = ?
       ORDER BY id DESC LIMIT 1`,
      [user_id, otpHash, purpose]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }
    const token = rows[0];
    if (token.used) {
      return res.status(400).json({ success: false, message: 'OTP already used.' });
    }
    const expiry = new Date(token.expires_at).getTime();
    if (Date.now() + 3 * 60 * 60 * 1000 > expiry) {
      return res.status(400).json({ success: false, message: 'OTP has expired.' });
    }

    await db.execute('UPDATE otp_tokens SET used = 1 WHERE id = ?', [token.id]);

    if (purpose === 'verify_phone') {
      await db.execute(
        'UPDATE users SET is_verified = 1, updated_at = ? WHERE id = ?', [now, user_id]
      );
    }

    res.json({ success: true, message: 'OTP verified successfully.', verified_at_eat: now });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ─────────────────────────────────────────
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const now = eatStr();

    const [rows] = await db.execute(
      `SELECT id, uuid, role, email, phone, first_name, last_name,
              password_hash, is_active, is_verified, failed_logins, locked_until
       FROM users WHERE email = ?`, [email]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    const user = rows[0];

    // Account lock check
    if (user.locked_until) {
      const lockTs = new Date(user.locked_until).getTime();
      if (Date.now() + 3 * 60 * 60 * 1000 < lockTs) {
        return res.status(423).json({ success: false,
          message: 'Account temporarily locked. Please try again later or reset your password.' });
      }
    }
    if (!user.is_active) {
      return res.status(401).json({ success: false, message: 'Account is inactive. Contact support.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const fails = user.failed_logins + 1;
      const lockUntil = fails >= 5
        ? eatStr(new Date(Date.now() + 3 * 60 * 60 * 1000 + 30 * 60 * 1000))
        : null;
      await db.execute(
        'UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?',
        [fails, lockUntil, now, user.id]
      );
      return res.status(401).json({ success: false,
        message: fails >= 5
          ? 'Too many failed attempts. Account locked for 30 minutes.'
          : 'Invalid email or password.' });
    }

    // Reset failed logins
    await db.execute(
      'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login = ?, updated_at = ? WHERE id = ?',
      [now, now, user.id]
    );

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user);
    const rtHash       = hashToken(refreshToken);
    const rtExpiry     = eatStr(new Date(Date.now() + 3 * 60 * 60 * 1000 + 7 * 24 * 60 * 60 * 1000));

    await db.execute(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
       VALUES (?,?,?,?)`,
      [user.id, rtHash, rtExpiry, now]
    );

    writeAudit({ actorId: user.id, actorRole: user.role, action: 'user.login',
      entity: 'users', entityId: user.id, ipAddress: req.ip });
    logger.info(`Login: ${email} at ${now} (EAT)`);

    res.json({
      success: true,
      message: 'Login successful.',
      login_time_eat: now,
      access_token:   accessToken,
      refresh_token:  refreshToken,
      expires_in:     process.env.JWT_EXPIRES_IN || '15m',
      user: {
        id: user.id, uuid: user.uuid, role: user.role,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email, phone: user.phone,
        is_verified: !!user.is_verified,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ───────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(401).json({ success: false, message: 'Refresh token required.' });
    }
    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
    }

    const rtHash = hashToken(refresh_token);
    const [rows] = await db.execute(
      'SELECT id, revoked FROM refresh_tokens WHERE token_hash = ? AND user_id = ?',
      [rtHash, payload.sub]
    );
    if (!rows.length || rows[0].revoked) {
      return res.status(401).json({ success: false, message: 'Refresh token revoked.' });
    }

    const [users] = await db.execute(
      'SELECT id, uuid, role, email, is_active FROM users WHERE id = ?', [payload.sub]
    );
    if (!users.length || !users[0].is_active) {
      return res.status(401).json({ success: false, message: 'User not found.' });
    }

    const newAccess = signAccess(users[0]);
    res.json({ success: true, access_token: newAccess, expires_in: process.env.JWT_EXPIRES_IN || '15m' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const rtHash = hashToken(refresh_token);
      await db.execute(
        'UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ? AND user_id = ?',
        [rtHash, req.user.id]
      );
    }
    writeAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'user.logout',
      entity: 'users', entityId: req.user.id, ipAddress: req.ip });
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ──────────────────────────────
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail(),
], validate, async (req, res, next) => {
  try {
    const { email } = req.body;
    const now = eatStr();
    const [rows] = await db.execute('SELECT id, first_name, phone FROM users WHERE email = ?', [email]);

    // Always respond OK to prevent email enumeration
    if (rows.length) {
      const user = rows[0];
      const otp  = makeOTP();
      const otpHash   = hashToken(otp);
      const otpExpiry = eatStr(new Date(Date.now() + 3 * 60 * 60 * 1000 + 15 * 60 * 1000));
      await db.execute(
        `INSERT INTO otp_tokens (user_id, token_hash, purpose, expires_at, created_at)
         VALUES (?,?,'reset_password',?,?)`,
        [user.id, otpHash, otpExpiry, now]
      );
      notif.sendSMS(user.phone,
        `Faster Loans Uganda: Your password reset code is ${otp}. Valid 15 minutes. Do not share.`
      ).catch(() => {});
      notif.sendEmail(email, 'Password Reset — Faster Loans Uganda', 'password_reset', {
        name: user.first_name, otp,
      }).catch(() => {});
    }

    res.json({ success: true,
      message: 'If that email exists, a reset code has been sent via SMS and email.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ───────────────────────────────
router.post('/reset-password', authLimiter, [
  body('user_id').isInt(),
  body('otp').isLength({ min: 6, max: 6 }),
  body('new_password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
], validate, async (req, res, next) => {
  try {
    const { user_id, otp, new_password } = req.body;
    const otpHash = hashToken(otp);
    const now     = eatStr();

    const [rows] = await db.execute(
      `SELECT id, expires_at, used FROM otp_tokens
       WHERE user_id = ? AND token_hash = ? AND purpose = 'reset_password'
       ORDER BY id DESC LIMIT 1`,
      [user_id, otpHash]
    );
    if (!rows.length || rows[0].used) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code.' });
    }
    if (new Date(rows[0].expires_at).getTime() < Date.now() + 3 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, message: 'Reset code has expired.' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.execute('UPDATE otp_tokens SET used = 1 WHERE id = ?', [rows[0].id]);
    await db.execute(
      'UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      [hash, now, user_id]
    );
    // Revoke all refresh tokens for security
    await db.execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [user_id]);

    writeAudit({ actorId: user_id, action: 'user.password_reset',
      entity: 'users', entityId: user_id, ipAddress: req.ip });
    res.json({ success: true, message: 'Password reset successfully. Please log in.', reset_at_eat: now });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ─────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.id, u.uuid, u.role, u.first_name, u.last_name, u.email, u.phone,
              u.national_id, u.district, u.address, u.is_verified, u.last_login, u.created_at,
              n.full_name AS kin_name, n.relationship AS kin_relation, n.phone AS kin_phone,
              b.bank_name, b.account_name
       FROM users u
       LEFT JOIN next_of_kin n ON n.user_id = u.id
       LEFT JOIN bank_accounts b ON b.user_id = u.id
       WHERE u.id = ?`, [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, user: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
