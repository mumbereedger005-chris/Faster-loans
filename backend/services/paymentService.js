'use strict';
// services/paymentService.js
// Pesapal (primary) + Flutterwave (fallback) payment integration
// Card mandate registration, recurring auto-debit, transaction verification
process.env.TZ = 'Africa/Kampala';

const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db/db');
const logger = require('./loggerService');
const { encrypt, decrypt } = require('../compliance/dataProtection');

function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T',' ').substring(0,19); }

// ═══════════════════════════════════════════════════════════════════
//  PESAPAL  (https://developer.pesapal.com)
//  Primary provider — supports Uganda direct debit / recurring
// ═══════════════════════════════════════════════════════════════════

const PESAPAL_BASE = process.env.PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

let pesapalToken     = null;
let pesapalTokenExp  = 0;

/** Obtain Pesapal OAuth2 bearer token (cached until expiry) */
async function getPesapalToken() {
  const now = Date.now();
  if (pesapalToken && now < pesapalTokenExp - 60000) return pesapalToken;

  const resp = await axios.post(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    consumer_key:    process.env.PESAPAL_CONSUMER_KEY,
    consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
  }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });

  pesapalToken    = resp.data.token;
  pesapalTokenExp = now + (resp.data.expiryDate
    ? new Date(resp.data.expiryDate).getTime() - now
    : 5 * 60 * 1000);
  return pesapalToken;
}

/** Register IPN (Instant Payment Notification) URL with Pesapal */
async function registerPesapalIPN() {
  try {
    const token = await getPesapalToken();
    const resp  = await axios.post(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
      url:             process.env.PESAPAL_IPN_URL,
      ipn_notification_type: 'POST',
    }, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
    logger.info('Pesapal IPN registered', { notification_id: resp.data.ipn_id });
    return resp.data.ipn_id;
  } catch (err) {
    logger.error('Pesapal IPN registration failed', { error: err.message });
  }
}

/**
 * Submit a payment order to Pesapal (used for one-time card payment / mandate setup)
 * @param {object} opts  { userId, loanId, amount, phone, email, firstName, lastName, reference, description }
 * @returns {{ orderTrackingId, redirectUrl }}
 */
async function pesapalSubmitOrder(opts) {
  const token = await getPesapalToken();
  const { userId, loanId, amount, phone, email, firstName, lastName, reference, description } = opts;

  const payload = {
    id:              reference,
    currency:        'UGX',
    amount:          parseFloat(amount),
    description:     description || `Loan repayment ${reference}`,
    callback_url:    `${process.env.FRONTEND_URL || 'https://fasterloans.co.ug'}/payment-result.html`,
    notification_id: process.env.PESAPAL_IPN_ID || '',
    billing_address: {
      email_address: email,
      phone_number:  phone,
      first_name:    firstName,
      last_name:     lastName,
      country_code:  'UG',
    },
  };

  const resp = await axios.post(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } }
  );

  logger.info(`Pesapal order submitted for ${reference}`, { orderTrackingId: resp.data.order_tracking_id });
  return {
    orderTrackingId: resp.data.order_tracking_id,
    redirectUrl:     resp.data.redirect_url,
    merchantRef:     reference,
  };
}

/**
 * Get transaction status from Pesapal
 * @param {string} orderTrackingId
 * @returns {{ status, amount, paymentMethod, confirmationCode }}
 */
async function pesapalGetStatus(orderTrackingId) {
  const token = await getPesapalToken();
  const resp  = await axios.get(
    `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  const d = resp.data;
  // Pesapal status_code: 1=INVALID, 2=FAILED, 3=COMPLETED, 4=PENDING, 5=REVERSED
  const statusMap = { 1:'failed', 2:'failed', 3:'success', 4:'pending', 5:'reversed' };
  return {
    status:           statusMap[d.status_code] || 'pending',
    amount:           d.amount,
    paymentMethod:    d.payment_method,
    confirmationCode: d.confirmation_code,
    description:      d.description,
    raw:              d,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  FLUTTERWAVE  (https://developer.flutterwave.com)
//  Fallback / alternative provider
// ═══════════════════════════════════════════════════════════════════

const FLW_BASE = 'https://api.flutterwave.com/v3';

/**
 * Charge a card token (recurring debit) via Flutterwave
 * @param {object} opts  { token, amount, email, phone, reference, narration }
 * @returns {{ status, transactionId, message }}
 */
async function flutterwaveChargeToken(opts) {
  const { token, amount, email, phone, reference, narration } = opts;
  const resp = await axios.post(`${FLW_BASE}/charges?type=card`, {
    token,
    currency:  'UGX',
    amount:    parseFloat(amount),
    email,
    phone_number: phone,
    tx_ref:    reference,
    narration: narration || 'Faster Loans Uganda auto-debit',
  }, {
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const d = resp.data;
  const ok = d.status === 'success' && d.data?.status === 'successful';
  return {
    status:        ok ? 'success' : 'failed',
    transactionId: d.data?.id,
    flwRef:        d.data?.flw_ref,
    message:       d.message,
    raw:           d,
  };
}

/**
 * Verify a Flutterwave transaction by ID
 * @param {string|number} transactionId
 */
async function flutterwaveVerify(transactionId) {
  const resp = await axios.get(`${FLW_BASE}/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
  });
  const d = resp.data?.data;
  return {
    status:   d?.status === 'successful' ? 'success' : 'failed',
    amount:   d?.amount,
    currency: d?.currency,
    flwRef:   d?.flw_ref,
    raw:      resp.data,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  MANDATE MANAGEMENT  (DB level)
// ═══════════════════════════════════════════════════════════════════

/**
 * Save a card mandate (tokenised) to the database.
 * cardToken = the token returned by the payment provider — NEVER store the raw PAN.
 */
async function saveMandateDB({ userId, loanId, cardToken, cardLastFour, cardBrand,
                                cardHolder, cardExpiry, mandateId, ip, userAgent }) {
  const now           = eatStr();
  const encryptedToken = encrypt(cardToken);   // AES-256 encrypt the token at rest
  await db.execute(
    `INSERT INTO card_mandates
       (user_id, loan_id, provider_mandate_id, card_last_four, card_brand,
        card_holder, card_expiry, card_token, is_active,
        authorised_at, consent_ip, consent_user_agent)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?)
     ON DUPLICATE KEY UPDATE
       card_token = VALUES(card_token), card_last_four = VALUES(card_last_four),
       card_expiry = VALUES(card_expiry), is_active = 1,
       authorised_at = VALUES(authorised_at)`,
    [userId, loanId || null, mandateId || null, cardLastFour, cardBrand || null,
     cardHolder || null, cardExpiry || null, encryptedToken, now, ip || null, userAgent || null]
  );
  logger.info(`Card mandate saved for user ${userId}, loan ${loanId} at ${now} EAT`);
}

/**
 * Get the active mandate token for a loan (decrypts before returning).
 */
async function getMandateForLoan(loanId) {
  const [rows] = await db.execute(
    `SELECT cm.*, u.email, u.phone, u.first_name, u.last_name
     FROM card_mandates cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.loan_id = ? AND cm.is_active = 1
     ORDER BY cm.id DESC LIMIT 1`,
    [loanId]
  );
  if (!rows.length) return null;
  const m = rows[0];
  m.card_token_plain = decrypt(m.card_token); // decrypt for use
  return m;
}

/**
 * Deactivate (revoke) a card mandate.
 */
async function revokeMandate(userId, loanId) {
  const now = eatStr();
  await db.execute(
    'UPDATE card_mandates SET is_active = 0, revoked_at = ? WHERE user_id = ? AND loan_id = ?',
    [now, userId, loanId]
  );
}

// ═══════════════════════════════════════════════════════════════════
//  CORE AUTO-DEBIT  (called by scheduler on 28th)
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute a single auto-debit for one loan installment.
 * Tries Flutterwave token charge first; Pesapal as fallback order.
 *
 * @param {object} loan   { id, user_id, monthly_installment, ... }
 * @param {object} sched  { id, installment_no, total_due, ... }
 * @returns {{ status: 'success'|'failed'|'pending', txnId, providerRef }}
 */
async function executeAutoDebit(loan, sched) {
  const now      = eatStr();
  const txnUuid  = uuidv4();
  const reference = `FL-AD-${loan.id}-${sched.installment_no}-${Date.now()}`;
  const amount   = parseFloat(sched.total_due);

  // Record pending transaction first
  await db.execute(
    `INSERT INTO transactions
       (uuid, loan_id, schedule_id, user_id, type, amount, currency,
        method, provider, status, created_at)
     VALUES (?,?,?,?,'repayment',?,'UGX','auto_debit','auto',  'pending',?)`,
    [txnUuid, loan.id, sched.id, loan.user_id, amount, now]
  );

  let result = { status: 'failed', message: 'No mandate found' };

  try {
    const mandate = await getMandateForLoan(loan.id);

    if (mandate?.card_token_plain) {
      // Try Flutterwave token charge
      result = await flutterwaveChargeToken({
        token:     mandate.card_token_plain,
        amount,
        email:     mandate.email,
        phone:     mandate.phone,
        reference,
        narration: `Faster Loans Uganda: Installment ${sched.installment_no} for loan ref ${reference}`,
      });
    } else {
      logger.warn(`No active card mandate for loan ${loan.id} — auto-debit skipped`);
      result = { status: 'failed', message: 'No active card mandate' };
    }
  } catch (err) {
    logger.error(`Auto-debit execution error for loan ${loan.id}`, { error: err.message });
    result = { status: 'failed', message: err.message };
  }

  // Update transaction record
  await db.execute(
    `UPDATE transactions SET status = ?, provider_ref = ?, failure_reason = ?, processed_at = ?
     WHERE uuid = ?`,
    [result.status, result.transactionId || result.flwRef || null,
     result.status === 'failed' ? result.message : null, now, txnUuid]
  );

  return { status: result.status, txnUuid, reference, message: result.message };
}

/**
 * Verify a transaction status from the provider and update DB.
 * @param {string} txnUuid  internal UUID
 * @returns {{ status, updated }}
 */
async function verifyTransaction(txnUuid) {
  const now = eatStr();
  const [rows] = await db.execute(
    'SELECT * FROM transactions WHERE uuid = ?', [txnUuid]
  );
  if (!rows.length) throw new Error('Transaction not found');
  const txn = rows[0];

  if (txn.status === 'success') return { status: 'success', updated: false };
  if (!txn.provider_ref)        return { status: txn.status, updated: false };

  let newStatus = txn.status;
  try {
    const verified = await flutterwaveVerify(txn.provider_ref);
    newStatus = verified.status;
    await db.execute(
      'UPDATE transactions SET status = ?, processed_at = ? WHERE uuid = ?',
      [newStatus, now, txnUuid]
    );
  } catch (err) {
    logger.error(`Transaction verify failed for ${txnUuid}`, { error: err.message });
  }

  return { status: newStatus, updated: newStatus !== txn.status };
}

module.exports = {
  // Pesapal
  getPesapalToken, registerPesapalIPN,
  pesapalSubmitOrder, pesapalGetStatus,
  // Flutterwave
  flutterwaveChargeToken, flutterwaveVerify,
  // Mandate management
  saveMandateDB, getMandateForLoan, revokeMandate,
  // Core
  executeAutoDebit, verifyTransaction,
};
