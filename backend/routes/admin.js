'use strict';
// routes/admin.js — Admin dashboard: customers, loans, overdue, reports, stats
process.env.TZ = 'Africa/Kampala';

const express = require('express');
const { body, query } = require('express-validator');

const db               = require('../db/db');
const { authenticate } = require('../middleware/auth');
const { requireRole }  = require('../middleware/rbac');
const { validate }     = require('../middleware/validate');
const { writeAudit }   = require('../middleware/auditLog');
const notif            = require('../services/notificationService');
const { maskAccountNumber } = require('../compliance/dataProtection');
const logger           = require('../services/loggerService');

const router = express.Router();

// All admin routes require at least 'officer' role
router.use(authenticate, requireRole('officer', 'admin', 'superadmin'));

function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T', ' ').substring(0, 19); }

// ── GET /api/admin/dashboard ─────────────────────────────────────
// Real-time KPI stats in Uganda time
router.get('/dashboard', async (req, res, next) => {
  try {
    const now = eatStr();

    const [[totals]] = await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='customer' AND is_active=1)          AS total_customers,
        (SELECT COUNT(*) FROM loan_applications WHERE status='pending')              AS pending_applications,
        (SELECT COUNT(*) FROM loan_applications WHERE status='under_review')        AS under_review,
        (SELECT COUNT(*) FROM loans WHERE status='active')                          AS active_loans,
        (SELECT COUNT(*) FROM loans WHERE status='completed')                       AS completed_loans,
        (SELECT COUNT(*) FROM loans WHERE status='defaulted')                       AS defaulted_loans,
        (SELECT IFNULL(SUM(principal),0) FROM loans WHERE status='active')          AS total_portfolio_ugx,
        (SELECT IFNULL(SUM(outstanding_balance),0) FROM loans WHERE status='active') AS outstanding_ugx,
        (SELECT IFNULL(SUM(amount_paid),0) FROM loans)                              AS total_collected_ugx,
        (SELECT COUNT(*) FROM repayment_schedule
           WHERE status='overdue')                                                   AS overdue_installments,
        (SELECT COUNT(*) FROM transactions
           WHERE status='success'
             AND created_at >= DATE_FORMAT(CONVERT_TZ(NOW(),'+00:00','+03:00'),'%Y-%m-01')) AS payments_this_month,
        (SELECT IFNULL(SUM(amount),0) FROM transactions
           WHERE type='disbursement' AND status='success'
             AND created_at >= DATE_FORMAT(CONVERT_TZ(NOW(),'+00:00','+03:00'),'%Y-%m-01')) AS disbursed_this_month
    `);

    // Monthly trend (last 6 months, Uganda calendar)
    const [monthly] = await db.execute(`
      SELECT
        DATE_FORMAT(CONVERT_TZ(la.applied_at,'+00:00','+03:00'),'%Y-%m') AS month,
        COUNT(*)                                                           AS applications,
        SUM(CASE WHEN la.status='disbursed' THEN 1 ELSE 0 END)           AS disbursed,
        IFNULL(SUM(l.principal),0)                                        AS amount_ugx
      FROM loan_applications la
      LEFT JOIN loans l ON l.application_id = la.id
      WHERE la.applied_at >= DATE_SUB(CONVERT_TZ(NOW(),'+00:00','+03:00'), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(CONVERT_TZ(la.applied_at,'+00:00','+03:00'),'%Y-%m')
      ORDER BY month DESC
    `);

    res.json({
      success: true,
      as_at_eat: now,
      timezone: 'Africa/Kampala (EAT UTC+3)',
      stats: totals,
      monthly_trend: monthly,
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/customers ──────────────────────────────────────
router.get('/customers', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '25'));
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const where  = search
      ? 'WHERE u.role="customer" AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.national_id LIKE ?)'
      : 'WHERE u.role="customer"';
    const params = search ? [search, search, search, search, search, limit, offset] : [limit, offset];

    const [rows] = await db.execute(`
      SELECT u.id, u.uuid, u.first_name, u.last_name, u.email, u.phone,
             u.national_id, u.district, u.is_verified, u.is_active, u.created_at,
             COUNT(DISTINCT la.id) AS total_applications,
             COUNT(DISTINCT l.id)  AS active_loans,
             IFNULL(SUM(l.outstanding_balance),0) AS total_outstanding
      FROM users u
      LEFT JOIN loan_applications la ON la.user_id = u.id
      LEFT JOIN loans l ON l.user_id = u.id AND l.status = 'active'
      ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`, params);

    const countParams = search ? [search, search, search, search, search] : [];
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM users u ${where}`, countParams
    );

    res.json({ success: true, total, page, limit, customers: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/customers/:id ─────────────────────────────────
router.get('/customers/:id', async (req, res, next) => {
  try {
    const [rows] = await db.execute(`
      SELECT u.*, n.full_name AS kin_name, n.relationship, n.phone AS kin_phone,
             b.bank_name, b.account_name, b.account_number_enc, b.verified AS bank_verified
      FROM users u
      LEFT JOIN next_of_kin n  ON n.user_id = u.id
      LEFT JOIN bank_accounts b ON b.user_id = u.id
      WHERE u.id = ? AND u.role = 'customer'`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const customer = rows[0];
    // Mask account number before sending
    if (customer.account_number_enc) {
      customer.account_number_masked = maskAccountNumber(
        require('../compliance/dataProtection').decrypt(customer.account_number_enc)
      );
      delete customer.account_number_enc;
      delete customer.password_hash;
    }

    const [docs] = await db.execute(
      'SELECT id, doc_type, verified, created_at FROM kyc_documents WHERE user_id = ?',
      [req.params.id]
    );
    const [loans] = await db.execute(`
      SELECT la.reference, la.status AS app_status, la.applied_at,
             l.principal, l.outstanding_balance, l.monthly_installment,
             l.next_due_date, l.status AS loan_status
      FROM loan_applications la
      LEFT JOIN loans l ON l.application_id = la.id
      WHERE la.user_id = ? ORDER BY la.applied_at DESC`, [req.params.id]
    );

    res.json({ success: true, customer, documents: docs, loans });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/customers/:id/status ────────────────────────
router.patch('/customers/:id/status', requireRole('admin', 'superadmin'), [
  body('is_active').isBoolean().withMessage('is_active (true/false) required'),
  body('reason').optional().trim(),
], validate, async (req, res, next) => {
  try {
    const now = eatStr();
    const { is_active, reason } = req.body;
    const userId = parseInt(req.params.id);

    const [old] = await db.execute('SELECT is_active FROM users WHERE id=?', [userId]);
    if (!old.length) return res.status(404).json({ success: false, message: 'Customer not found.' });

    await db.execute(
      'UPDATE users SET is_active=?, updated_at=? WHERE id=?',
      [is_active ? 1 : 0, now, userId]
    );

    writeAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: is_active ? 'customer.activated' : 'customer.deactivated',
      entity: 'users', entityId: userId,
      oldValues: { is_active: old[0].is_active },
      newValues:  { is_active: is_active ? 1 : 0, reason, changed_at: now },
      ipAddress: req.ip });

    res.json({
      success: true,
      message: `Customer ${is_active ? 'activated' : 'deactivated'} at ${now} EAT.`,
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/applications ───────────────────────────────────
router.get('/applications', async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '25'));
    const offset = (page - 1) * limit;

    const where  = status ? 'WHERE la.status = ?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const [rows] = await db.execute(`
      SELECT la.id, la.reference, la.amount_requested, la.tenure_months,
             la.status, la.applied_at, la.approved_at, la.disbursed_at,
             lp.name AS product,
             u.first_name, u.last_name, u.email, u.phone, u.national_id,
             o.first_name AS officer_first, o.last_name AS officer_last
      FROM loan_applications la
      JOIN loan_products lp ON lp.id = la.product_id
      JOIN users u           ON u.id  = la.user_id
      LEFT JOIN users o      ON o.id  = la.officer_id
      ${where}
      ORDER BY la.applied_at DESC
      LIMIT ? OFFSET ?`, params
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM loan_applications la ${where}`,
      status ? [status] : []
    );

    res.json({ success: true, total, page, limit, applications: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/loans ──────────────────────────────────────────
router.get('/loans', async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '25'));
    const offset = (page - 1) * limit;

    const where  = status ? 'WHERE l.status = ?' : '';
    const params = status ? [status, limit, offset] : [limit, offset];

    const [rows] = await db.execute(`
      SELECT l.id, la.reference, l.principal, l.monthly_installment,
             l.outstanding_balance, l.amount_paid, l.next_due_date,
             l.installments_paid, l.installments_remaining,
             l.status, l.disbursed_at,
             lp.name AS product,
             u.first_name, u.last_name, u.email, u.phone
      FROM loans l
      JOIN loan_applications la ON la.id = l.application_id
      JOIN loan_products lp     ON lp.id = l.product_id
      JOIN users u              ON u.id  = l.user_id
      ${where}
      ORDER BY l.disbursed_at DESC
      LIMIT ? OFFSET ?`, params
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM loans l ${where}`,
      status ? [status] : []
    );

    res.json({ success: true, total, page, limit, loans: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/overdue ────────────────────────────────────────
// All overdue installments with customer contact details
router.get('/overdue', async (req, res, next) => {
  try {
    const now     = eatStr();
    const todayEAT = now.substring(0, 10);

    const [rows] = await db.execute(`
      SELECT rs.id AS schedule_id, rs.installment_no, rs.due_date, rs.reminder_date,
             rs.total_due, rs.paid_amount,
             (rs.total_due - rs.paid_amount) AS amount_outstanding,
             DATEDIFF('${todayEAT}', rs.due_date) AS days_overdue,
             rs.status,
             la.reference AS loan_reference,
             l.id AS loan_id, l.outstanding_balance,
             u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
             u.national_id
      FROM repayment_schedule rs
      JOIN loans l               ON l.id  = rs.loan_id
      JOIN loan_applications la  ON la.id = l.application_id
      JOIN users u               ON u.id  = l.user_id
      WHERE rs.due_date < ? AND rs.status IN ('pending','partial')
        AND l.status = 'active'
      ORDER BY days_overdue DESC`, [todayEAT]
    );

    // Mark overdue in DB if not already
    if (rows.length) {
      const ids = rows.map(r => r.schedule_id);
      await db.execute(
        `UPDATE repayment_schedule SET status='overdue'
         WHERE id IN (${ids.map(() => '?').join(',')})
           AND status NOT IN ('paid','overdue','waived')`,
        ids
      );
    }

    res.json({
      success: true,
      as_at_eat: now,
      total_overdue: rows.length,
      overdue: rows,
    });
  } catch (err) { next(err); }
});

// ── POST /api/admin/overdue/:scheduleId/notify ────────────────────
// Manually trigger overdue SMS/email to a customer
router.post('/overdue/:scheduleId/notify', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const now = eatStr();
    const [rows] = await db.execute(`
      SELECT rs.total_due, rs.paid_amount, rs.due_date,
             la.reference, u.email, u.phone, u.first_name, u.id AS user_id
      FROM repayment_schedule rs
      JOIN loans l              ON l.id  = rs.loan_id
      JOIN loan_applications la ON la.id = l.application_id
      JOIN users u              ON u.id  = l.user_id
      WHERE rs.id = ?`, [req.params.scheduleId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Schedule not found.' });

    const r = rows[0];
    const outstanding = parseFloat(r.total_due) - parseFloat(r.paid_amount);

    await notif.sendSMS(r.phone,
      `URGENT — Faster Loans Uganda: Your loan installment of UGX ${outstanding.toLocaleString()} (Ref: ${r.reference}) was due on ${r.due_date} and is OVERDUE. Please make payment immediately to avoid penalties. Call ${process.env.COMPANY_PHONE}.`,
      r.user_id, 'overdue_reminder'
    );

    writeAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'overdue.manual_notify', entity: 'repayment_schedule',
      entityId: req.params.scheduleId,
      newValues: { notified_at: now }, ipAddress: req.ip });

    res.json({ success: true, message: `Overdue notification sent to ${r.phone} at ${now} EAT.` });
  } catch (err) { next(err); }
});

// ── GET /api/admin/transactions ───────────────────────────────────
router.get('/transactions', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '25'));
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const type   = req.query.type   || null;

    const conditions = [];
    const params     = [];
    if (status) { conditions.push('t.status = ?'); params.push(status); }
    if (type)   { conditions.push('t.type = ?');   params.push(type); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rows] = await db.execute(`
      SELECT t.uuid, t.type, t.amount, t.currency, t.method, t.provider,
             t.provider_ref, t.status, t.failure_reason,
             t.processed_at, t.created_at,
             la.reference AS loan_reference,
             u.first_name, u.last_name, u.phone
      FROM transactions t
      LEFT JOIN loans l              ON l.id  = t.loan_id
      LEFT JOIN loan_applications la ON la.id = l.application_id
      JOIN users u                   ON u.id  = t.user_id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?`, [...params, limit, offset]
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM transactions t ${where}`, params
    );

    res.json({ success: true, total, page, limit, transactions: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reports/summary ────────────────────────────────
// Monthly summary report — Uganda EAT calendar
router.get('/reports/summary', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const now   = eatStr();
    const year  = parseInt(req.query.year  || eatNow().getFullYear());
    const month = parseInt(req.query.month || (eatNow().getMonth() + 1));

    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    const [[summary]] = await db.execute(`
      SELECT
        '${monthStr}' AS report_month,
        (SELECT COUNT(*) FROM loan_applications
           WHERE DATE_FORMAT(CONVERT_TZ(applied_at,'+00:00','+03:00'),'%Y-%m') = ?)  AS new_applications,
        (SELECT COUNT(*) FROM loan_applications
           WHERE DATE_FORMAT(CONVERT_TZ(approved_at,'+00:00','+03:00'),'%Y-%m') = ?
             AND status IN ('approved','disbursed'))                                   AS approvals,
        (SELECT COUNT(*) FROM loan_applications
           WHERE DATE_FORMAT(CONVERT_TZ(disbursed_at,'+00:00','+03:00'),'%Y-%m') = ?
             AND status = 'disbursed')                                                 AS disbursements,
        (SELECT IFNULL(SUM(amount_requested),0) FROM loan_applications
           WHERE DATE_FORMAT(CONVERT_TZ(disbursed_at,'+00:00','+03:00'),'%Y-%m') = ?
             AND status = 'disbursed')                                                 AS disbursed_ugx,
        (SELECT COUNT(*) FROM transactions
           WHERE type='repayment' AND status='success'
             AND DATE_FORMAT(CONVERT_TZ(processed_at,'+00:00','+03:00'),'%Y-%m') = ?) AS repayments_received,
        (SELECT IFNULL(SUM(amount),0) FROM transactions
           WHERE type='repayment' AND status='success'
             AND DATE_FORMAT(CONVERT_TZ(processed_at,'+00:00','+03:00'),'%Y-%m') = ?) AS repayments_ugx,
        (SELECT COUNT(*) FROM transactions
           WHERE type='repayment' AND status='failed'
             AND DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','+03:00'),'%Y-%m') = ?)   AS failed_debits,
        (SELECT COUNT(*) FROM repayment_schedule
           WHERE status='overdue'
             AND DATE_FORMAT(due_date,'%Y-%m') = ?)                                    AS overdue_installments,
        (SELECT COUNT(*) FROM users WHERE role='customer'
           AND DATE_FORMAT(CONVERT_TZ(created_at,'+00:00','+03:00'),'%Y-%m') = ?)     AS new_customers
    `, Array(9).fill(monthStr));

    res.json({
      success: true,
      generated_at_eat: now,
      timezone: 'Africa/Kampala (EAT UTC+3)',
      report: summary,
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reports/audit-log ──────────────────────────────
router.get('/reports/audit-log', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;

    const [rows] = await db.execute(`
      SELECT al.id, al.actor_id, al.actor_role, al.action, al.entity,
             al.entity_id, al.old_values, al.new_values,
             al.ip_address, al.created_at,
             u.first_name, u.last_name, u.email
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?`, [limit, offset]
    );
    const [[{ total }]] = await db.execute('SELECT COUNT(*) AS total FROM audit_logs');

    res.json({ success: true, total, page, limit, logs: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/notifications ─────────────────────────────────
router.get('/notifications', async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(100, parseInt(req.query.limit || '25'));
    const offset = (page - 1) * limit;

    const [rows] = await db.execute(`
      SELECT n.id, n.channel, n.type, n.recipient, n.status, n.sent_at, n.error_msg, n.created_at,
             u.first_name, u.last_name
      FROM notifications n
      JOIN users u ON u.id = n.user_id
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?`, [limit, offset]
    );
    const [[{ total }]] = await db.execute('SELECT COUNT(*) AS total FROM notifications');

    res.json({ success: true, total, page, limit, notifications: rows });
  } catch (err) { next(err); }
});

// ── POST /api/admin/loans/:id/write-off ──────────────────────────
router.post('/loans/:id/write-off', requireRole('superadmin'), [
  body('reason').trim().notEmpty().withMessage('Write-off reason required'),
], validate, async (req, res, next) => {
  try {
    const now    = eatStr();
    const loanId = parseInt(req.params.id);

    const [lr] = await db.execute(
      'SELECT id, outstanding_balance, status FROM loans WHERE id = ?', [loanId]
    );
    if (!lr.length) return res.status(404).json({ success: false, message: 'Loan not found.' });
    if (!['active', 'defaulted'].includes(lr[0].status)) {
      return res.status(400).json({ success: false, message: 'Loan is not active or defaulted.' });
    }

    await db.execute(
      'UPDATE loans SET status=\'written_off\', completed_at=? WHERE id=?', [now, loanId]
    );

    writeAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'loan.written_off', entity: 'loans', entityId: loanId,
      oldValues: { status: lr[0].status, balance: lr[0].outstanding_balance },
      newValues: { status: 'written_off', reason: req.body.reason, written_off_at: now },
      ipAddress: req.ip });

    logger.info(`Loan ${loanId} written off by ${req.user.id} at ${now} EAT. Reason: ${req.body.reason}`);
    res.json({ success: true, message: 'Loan written off.', written_off_at_eat: now });
  } catch (err) { next(err); }
});

module.exports = router;
