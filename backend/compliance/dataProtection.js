'use strict';
// compliance/dataProtection.js
// AES-256-CBC encrypt/decrypt for sensitive data (account numbers, card tokens)
// PDPA Uganda 2019 consent helpers
// Audit log writer
process.env.TZ = 'Africa/Kampala';

const crypto = require('crypto');
const db     = require('../db/db');
const logger = require('../services/loggerService');

// ── Uganda EAT helper ────────────────────────────────────────────
function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T',' ').substring(0,19); }

// ── AES-256-CBC Encryption ───────────────────────────────────────
const ALGO = 'aes-256-cbc';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters in .env');
  return Buffer.from(key.substring(0,64), 'hex').slice(0,32);
}

function getIV() {
  const iv = process.env.ENCRYPTION_IV;
  if (iv && iv.length >= 32) return Buffer.from(iv.substring(0,32), 'hex').slice(0,16);
  // Derive a fixed IV from the key (deterministic but unique per key)
  return crypto.createHash('md5').update(process.env.ENCRYPTION_KEY || 'faster_loans_ug').digest();
}

/**
 * Encrypt plaintext → base64 ciphertext
 * @param {string} plaintext
 * @returns {string} base64 encoded encrypted string
 */
function encrypt(plaintext) {
  try {
    if (!plaintext) return '';
    const cipher = crypto.createCipheriv(ALGO, getKey(), getIV());
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
  } catch (err) {
    logger.error('Encryption failed', { error: err.message });
    throw new Error('Encryption failed. Check ENCRYPTION_KEY in .env');
  }
}

/**
 * Decrypt base64 ciphertext → plaintext
 * @param {string} ciphertext  base64 string
 * @returns {string}
 */
function decrypt(ciphertext) {
  try {
    if (!ciphertext) return '';
    const decipher  = crypto.createDecipheriv(ALGO, getKey(), getIV());
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('Decryption failed', { error: err.message });
    throw new Error('Decryption failed.');
  }
}

/**
 * Hash a value with SHA-256 (for tokens, OTPs, file integrity)
 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Mask an account number for display: show only last 4 digits
 * e.g. "9030012345678" → "•••••••••4678"
 */
function maskAccountNumber(raw) {
  if (!raw || raw.length < 4) return '••••';
  return '•'.repeat(raw.length - 4) + raw.slice(-4);
}

/**
 * Mask card number: show only last 4
 */
function maskCardNumber(raw) {
  if (!raw) return '•••• •••• •••• ••••';
  const digits = raw.replace(/\D/g, '');
  return '•••• •••• •••• ' + digits.slice(-4);
}

// ── PDPA Uganda 2019 — Consent Helpers ───────────────────────────

/**
 * Record a user consent in the database.
 * @param {object} opts
 *   userId, consentType, granted (bool), version, ipAddress, userAgent, conn (optional)
 */
async function recordConsent(opts) {
  const {
    userId, consentType, granted = true,
    version = process.env.TERMS_VERSION || '1.0',
    ipAddress = null, userAgent = null,
    conn = null,
  } = opts;
  const now = eatStr();
  const db_ = conn || db;
  await db_.execute(
    `INSERT INTO consent_records
       (user_id, consent_type, granted, version, ip_address, user_agent, granted_at)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, consentType, granted ? 1 : 0, version, ipAddress, userAgent, now]
  );
}

/**
 * Check whether a user has valid (not revoked) consent for a given type.
 * @param {number} userId
 * @param {string} consentType
 * @returns {boolean}
 */
async function hasConsent(userId, consentType) {
  const [rows] = await db.execute(
    `SELECT id FROM consent_records
     WHERE user_id = ? AND consent_type = ? AND granted = 1 AND revoked_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [userId, consentType]
  );
  return rows.length > 0;
}

/**
 * Revoke a consent (e.g. user withdraws auto-debit mandate).
 */
async function revokeConsent(userId, consentType) {
  const now = eatStr();
  await db.execute(
    `UPDATE consent_records SET revoked_at = ?
     WHERE user_id = ? AND consent_type = ? AND revoked_at IS NULL`,
    [now, userId, consentType]
  );
}

// ── Data Retention (PDPA Article 26) ─────────────────────────────

/**
 * Anonymise a closed/written-off customer record after retention period.
 * Called by a separate cleanup job (not the auto-debit scheduler).
 * Replaces PII with hashed/anonymised values.
 */
async function anonymiseUser(userId) {
  const now = eatStr();
  const anon = sha256(`ANON_${userId}_${Date.now()}`).substring(0, 16);
  await db.execute(
    `UPDATE users SET
       first_name = 'ANONYMISED', last_name = 'ANONYMISED',
       email = ?, phone = ?,
       national_id = NULL, address = NULL,
       is_active = 0, updated_at = ?
     WHERE id = ?`,
    [`anon_${anon}@deleted.invalid`, `+25600000${userId}`, now, userId]
  );
  logger.info(`User ${userId} anonymised at ${now} EAT (PDPA retention)`);
}

// ── Audit Log Writer ──────────────────────────────────────────────

/**
 * Write an immutable audit entry. Never throws — failures are logged only.
 */
async function writeAuditEntry(opts) {
  try {
    const {
      actorId = null, actorRole = null,
      action, entity = null, entityId = null,
      oldValues = null, newValues = null,
      ipAddress = null, userAgent = null,
    } = opts;
    const now = eatStr();
    await db.execute(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity, entity_id,
          old_values, new_values, ip_address, user_agent, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        actorId, actorRole, action, entity,
        entityId != null ? String(entityId) : null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress, userAgent, now,
      ]
    );
  } catch (err) {
    logger.error('Audit write failed', { error: err.message, opts });
  }
}

module.exports = {
  encrypt, decrypt, sha256,
  maskAccountNumber, maskCardNumber,
  recordConsent, hasConsent, revokeConsent,
  anonymiseUser, writeAuditEntry,
  eatNow, eatStr,
};
