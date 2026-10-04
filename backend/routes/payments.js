'use strict';
// routes/payments.js
// POST /api/payments/mandate        — register card for auto-debit
// DELETE /api/payments/mandate/:loanId — revoke mandate
// POST /api/payments/verify          — verify a transaction
// POST /api/payments/webhook/pesapal — Pesapal IPN callback
// POST /api/payments/webhook/flutterwave — Flutterwave webhook
// GET  /api/payments/history         — customer payment history
process.env.TZ = 'Africa/Kampala';

const express      = require('express');
const crypto       = require('crypto');
const { body }     = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const db           = require('../db/db');
const { authenticate } = require('../middleware/auth');
const { requireRole }  = require('../middleware/rbac');
const { validate }     = require('../middleware/validate');
const { writeAudit }   = require('../middleware/auditLog');
const payment      = require('../services/paymentService');
const notif        = require('../services/notificationService');
const { applyRepayment } = require('../services/loanService');
const { hasConsent }     = require('../compliance/dataProtection');
const logger       = require('../services/loggerService');

const router = express.Router();

function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T',' ').substring(0,19); }

// ── POST /api/payments/mandate ───────────────────────────────────
// Customer registers their card for auto-debit
router.post('/mandate', authenticate, [
  body('loan_id').isInt({ min: 1 }).withMessage('Valid loan_id required'),
  body('card_token').notEmpty().withMessage('card_token from payment provider required'),
  body('card_last_four').isLength({ min:4, max:4 }).isNumeric().withMessage('card_last_four must be 4 digits'),
  body('card_brand').optional().trim(),
  body('card_holder').trim().notEmpty().withMessage('card_holder name required'),
  body('card_expiry').matches(/^\d{2}\/\d{2}$/).withMessage('card_expiry must be MM/YY'),
  body('mandate_id').optional().trim(),
  body('consent_auto_debit').equals('true').withMessage('Auto-debit authorisation required'),
], validate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now    = eatStr();
    const { loan_id, card_token, card_last_four, card_brand,
            card_holder, card_expiry, mandate_id } = req.body;

    // Verify loan belongs to this user
    const [loanRows] = await db.execute(
      'SELECT id, status FROM loans WHERE id = ? AND user_id = ?',
      [loan_id, userId]
    );
    if (!loanRows.length) {
      return res.status(404).json({ success:false, message:'Loan not found or does not belong to you.' });
    }
    if (!['active'].includes(loanRows[0].status)) {
      return res.status(400).json({ success:false, message:'Can only register a mandate for an active loan.' });
    }

    // Verify auto-debit consent exists
    const consentOK = await hasConsent(userId, 'auto_debit_mandate');
    if (!consentOK) {
      return res.status(403).json({ success:false,
        message:'Auto-debit mandate consent not recorded. Please re-apply or contact support.' });
    }

    await payment.saveMandateDB({
      userId, loanId: parseInt(loan_id),
      cardToken: card_token, cardLastFour: card_last_four,
      cardBrand: card_brand, cardHolder: card_holder,
      cardExpiry: card_expiry, mandateId: mandate_id,
      ip: req.ip, userAgent: req.headers['user-agent'],
    });

    writeAudit({ actorId: userId, actorRole: req.user.role, action: 'mandate.registered',
      entity: 'card_mandates', entityId: loan_id,
      newValues: { card_last_four, card_brand, card_expiry, registered_at: now },
      ipAddress: req.ip });

    // Notify customer
    const [u] = await db.execute('SELECT email, phone, first_name FROM users WHERE id=?', [userId]);
    notif.sendSMS(u[0].phone,
      `Faster Loans Uganda: Your card ending ${card_last_four} has been registered for auto-debit repayment on the 28th of every month. SMS reminder will be sent on the 25th.`
    ).catch(()=>{});

    logger.info(`Mandate registered: user ${userId}, loan ${loan_id}, card ****${card_last_four} at ${now} EAT`);
    res.status(201).json({
      success: true,
      message: 'Card mandate registered successfully. Auto-debit will occur on the 28th of every month.',
      data: {
        loan_id:        parseInt(loan_id),
        card_last_four, card_brand, card_expiry,
        deduction_day:  28,
        reminder_day:   25,
        registered_at_eat: now,
      },
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/payments/mandate/:loanId ─────────────────────────
// Revoke card mandate (customer or admin)
router.delete('/mandate/:loanId', authenticate, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const loanId = parseInt(req.params.loanId);
    const now    = eatStr();

    const isAdmin = ['admin','superadmin'].includes(req.user.role);
    if (!isAdmin) {
      // Verify loan belongs to this user
      const [lr] = await db.execute('SELECT id FROM loans WHERE id=? AND user_id=?', [loanId, userId]);
      if (!lr.length) return res.status(404).json({ success:false, message:'Loan not found.' });
    }

    await payment.revokeMandate(userId, loanId);

    writeAudit({ actorId: userId, actorRole: req.user.role, action: 'mandate.revoked',
      entity: 'card_mandates', entityId: loanId,
      newValues: { revoked_at: now }, ipAddress: req.ip });

    logger.info(`Mandate revoked: user ${userId}, loan ${loanId} at ${now} EAT`);
    res.json({ success:true, message:'Card mandate revoked. No further auto-debits will occur.', revoked_at_eat: now });
  } catch (err) { next(err); }
});

// ── POST /api/payments/verify ────────────────────────────────────
// Verify a transaction status with the payment provider
router.post('/verify', authenticate, [
  body('txn_uuid').notEmpty().withMessage('txn_uuid required'),
], validate, async (req, res, next) => {
  try {
    const { txn_uuid } = req.body;
    const now = eatStr();

    // Confirm transaction belongs to this user (or admin)
    const isAdmin = ['admin','superadmin','officer'].includes(req.user.role);
    const [txRows] = await db.execute(
      'SELECT * FROM transactions WHERE uuid=?', [txn_uuid]
    );
    if (!txRows.length) return res.status(404).json({ success:false, message:'Transaction not found.' });
    if (!isAdmin && txRows[0].user_id !== req.user.id) {
      return res.status(403).json({ success:false, message:'Access denied.' });
    }

    const result = await payment.verifyTransaction(txn_uuid);

    // If newly confirmed successful, apply repayment to loan ledger
    if (result.status === 'success' && result.updated) {
      const txn = txRows[0];
      if (txn.loan_id && txn.schedule_id) {
        const conn = await db.getConnection();
        try {
          await conn.beginTransaction();
          const { newBalance, loanStatus } = await applyRepayment(
            conn, txn.loan_id, txn.schedule_id, txn.amount
          );
          await conn.commit();

          // Notify customer
          const [u] = await db.execute(
            'SELECT email, phone, first_name FROM users WHERE id=?', [txn.user_id]
          );
          const [loanRef] = await db.execute(
            'SELECT la.reference, l.next_due_date FROM loans l JOIN loan_applications la ON la.id = l.application_id WHERE l.id=?',
            [txn.loan_id]
          );
          notif.sendSMS(u[0].phone,
            `Faster Loans Uganda: Payment of UGX ${parseFloat(txn.amount).toLocaleString()} confirmed on ${now} (Uganda time). Balance: UGX ${parseFloat(newBalance).toLocaleString()}. ${loanStatus === 'completed' ? 'Loan fully repaid. Thank you!' : `Next debit: 28th.`}`
          ).catch(()=>{});
          notif.sendEmail(u[0].email, 'Payment Confirmed', 'payment_success', {
            name:     u[0].first_name,
            reference: loanRef[0]?.reference || '-',
            amount:   parseFloat(txn.amount).toLocaleString(),
            txn_id:   txn_uuid,
            paid_at:  now,
            balance:  parseFloat(newBalance).toLocaleString(),
            next_due: loanRef[0]?.next_due_date || null,
          }, txn.user_id).catch(()=>{});

          writeAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'payment.verified_success',
            entity: 'transactions', entityId: txn_uuid,
            newValues: { status: 'success', new_balance: newBalance }, ipAddress: req.ip });
        } catch (e) {
          await conn.rollback();
          logger.error('applyRepayment failed after verify', { error: e.message });
        } finally { conn.release(); }
      }
    }

    res.json({
      success:   true,
      txn_uuid,
      status:    result.status,
      updated:   result.updated,
      verified_at_eat: now,
    });
  } catch (err) { next(err); }
});

// ── POST /api/payments/webhook/pesapal ───────────────────────────
// Pesapal IPN — verifies signature, updates transaction
router.post('/webhook/pesapal', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const now  = eatStr();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { orderTrackingId, merchantReference, orderMerchantReference } = body;

    logger.info(`Pesapal IPN received at ${now} EAT`, { orderTrackingId, merchantReference });

    // Verify status with Pesapal
    const status = await payment.pesapalGetStatus(orderTrackingId);

    // Find matching transaction by provider_ref or loan reference
    const [txRows] = await db.execute(
      `SELECT * FROM transactions WHERE provider_ref = ? OR provider_ref = ?`,
      [orderTrackingId, merchantReference || '']
    );

    if (txRows.length && status.status === 'success') {
      const txn = txRows[0];
      await db.execute(
        'UPDATE transactions SET status=\'success\', processed_at=? WHERE id=?',
        [now, txn.id]
      );

      if (txn.loan_id && txn.schedule_id) {
        const conn = await db.getConnection();
        try {
          await conn.beginTransaction();
          await applyRepayment(conn, txn.loan_id, txn.schedule_id, txn.amount);
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          logger.error('applyRepayment failed in Pesapal webhook', { error: e.message });
        } finally { conn.release(); }
      }
    }

    // Always respond 200 to Pesapal
    res.status(200).json({ orderNotificationType: 'IPNCHANGE', orderTrackingId, status: 'OK' });
  } catch (err) {
    logger.error('Pesapal webhook error', { error: err.message });
    res.status(200).json({ status: 'RECEIVED' }); // always 200 to avoid IPN retries
  }
});

// ── POST /api/payments/webhook/flutterwave ───────────────────────
// Flutterwave webhook — verifies hash, processes payment
router.post('/webhook/flutterwave', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const now  = eatStr();
    const sig  = req.headers['verif-hash'];
    const expected = process.env.FLW_WEBHOOK_HASH;
    if (expected && sig !== expected) {
      logger.warn(`Flutterwave webhook: invalid hash at ${now} EAT`);
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event, data } = body;
    logger.info(`Flutterwave webhook [${event}] at ${now} EAT`, { txRef: data?.tx_ref });

    if (event === 'charge.completed' && data?.status === 'successful') {
      // Verify independently with Flutterwave
      const verified = await payment.flutterwaveVerify(data.id);
      if (verified.status === 'success') {
        // Find transaction by tx_ref
        const [txRows] = await db.execute(
          'SELECT * FROM transactions WHERE provider_ref = ?', [String(data.id)]
        );
        if (txRows.length) {
          const txn = txRows[0];
          await db.execute(
            'UPDATE transactions SET status=\'success\', processed_at=? WHERE id=?',
            [now, txn.id]
          );
          if (txn.loan_id && txn.schedule_id) {
            const conn = await db.getConnection();
            try {
              await conn.beginTransaction();
              await applyRepayment(conn, txn.loan_id, txn.schedule_id, txn.amount);
              await conn.commit();
            } catch (e) {
              await conn.rollback();
              logger.error('applyRepayment in FLW webhook', { error: e.message });
            } finally { conn.release(); }
          }
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Flutterwave webhook error', { error: err.message });
    res.status(200).json({ received: true });
  }
});

// ── GET /api/payments/history ─────────────────────────────────────
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const isAdmin = ['admin','superadmin','officer'].includes(req.user.role);
    const userId  = isAdmin && req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
    const page    = Math.max(1, parseInt(req.query.page  || '1'));
    const limit   = Math.min(50, parseInt(req.query.limit || '20'));
    const offset  = (page - 1) * limit;

    const [rows] = await db.execute(
      `SELECT t.uuid, t.type, t.amount, t.currency, t.method, t.provider,
              t.provider_ref, t.status, t.failure_reason, t.processed_at, t.created_at,
              la.reference AS loan_reference,
              rs.installment_no, rs.due_date
       FROM transactions t
       LEFT JOIN loans l         ON l.id = t.loan_id
       LEFT JOIN loan_applications la ON la.id = l.application_id
       LEFT JOIN repayment_schedule rs ON rs.id = t.schedule_id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    const [[{ total }]] = await db.execute(
      'SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?', [userId]
    );

    res.json({ success:true, total, page, limit, transactions: rows });
  } catch (err) { next(err); }
});

module.exports = router;
