'use strict';
// routes/loans.js — Apply, My Loans, Schedule, Admin Approve/Reject/Disburse
process.env.TZ = 'Africa/Kampala';
const express   = require('express');
const { body, param } = require('express-validator');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db         = require('../db/db');
const { authenticate }      = require('../middleware/auth');
const { requireRole }       = require('../middleware/rbac');
const { validate }          = require('../middleware/validate');
const { writeAudit, auditMiddleware } = require('../middleware/auditLog');
const { buildSchedule, saveSchedule, generateRef, calcInstallment, eatStr, eatNow } = require('../services/loanService');
const notif      = require('../services/notificationService');
const logger     = require('../services/loggerService');

const router = express.Router();

// ── File upload config ────────────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  },
});
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();
  allowed.includes(ext) ? cb(null, true) : cb(new Error('Only JPG, PNG, PDF allowed'));
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '5')) * 1024 * 1024 },
});

const docFields = [
  { name: 'nid_front',       maxCount: 1 },
  { name: 'nid_back',        maxCount: 1 },
  { name: 'passport_photo',  maxCount: 1 },
  { name: 'bank_statement',  maxCount: 1 },
  { name: 'business_cert',   maxCount: 1 },
  { name: 'collateral_doc',  maxCount: 1 },
];

// ── POST /api/loans/apply ─────────────────────────────────────────
router.post('/apply', authenticate, upload.fields(docFields), [
  body('product_code').notEmpty().withMessage('Loan product required'),
  body('amount').isFloat({ min: 250000, max: 30000000 }).withMessage('Amount must be between UGX 250,000 and 30,000,000'),
  body('tenure_months').isInt({ min: 1, max: 48 }).withMessage('Tenure must be 1–48 months'),
  body('purpose').trim().notEmpty().withMessage('Loan purpose required'),
  body('employment_status').notEmpty().withMessage('Employment status required'),
  body('monthly_income').notEmpty().withMessage('Monthly income required'),
  body('bank_name').notEmpty().withMessage('Bank name required'),
  body('account_number').notEmpty().withMessage('Account number required'),
  body('account_name').notEmpty().withMessage('Account holder name required'),
  body('kin_name').notEmpty().withMessage('Next of kin name required'),
  body('kin_relationship').notEmpty().withMessage('Next of kin relationship required'),
  body('kin_phone').notEmpty().withMessage('Next of kin phone required'),
  body('consent_auto_debit').equals('true').withMessage('You must authorise the auto-debit mandate'),
  body('consent_terms').equals('true').withMessage('You must accept the Terms & Conditions'),
], validate, async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.user.id;
    const now    = eatStr();

    const {
      product_code, amount, tenure_months, purpose,
      employment_status, employer_name, monthly_income,
      guarantor, collateral_type,
      bank_name, account_number, account_name, bank_branch,
      kin_name, kin_relationship, kin_phone, kin_address,
    } = req.body;

    // Validate product
    const [products] = await conn.execute(
      'SELECT * FROM loan_products WHERE code = ? AND is_active = 1', [product_code]
    );
    if (!products.length) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid loan product.' });
    }
    const product = products[0];

    // Check amount range
    if (parseFloat(amount) < product.min_amount || parseFloat(amount) > product.max_amount) {
      await conn.rollback();
      return res.status(400).json({ success: false,
        message: `Amount must be between UGX ${product.min_amount.toLocaleString()} and UGX ${product.max_amount.toLocaleString()} for ${product.name}.` });
    }

    // Check no active pending/approved loan for same user
    const [existing] = await conn.execute(
      `SELECT id FROM loan_applications
       WHERE user_id = ? AND status IN ('pending','under_review','approved','disbursed')`,
      [userId]
    );
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ success: false,
        message: 'You already have an active loan application. Please wait for it to be resolved.' });
    }

    // Generate unique reference
    let reference;
    let refExists = true;
    while (refExists) {
      reference = generateRef();
      const [r] = await conn.execute(
        'SELECT id FROM loan_applications WHERE reference = ?', [reference]
      );
      refExists = r.length > 0;
    }

    // Insert application — applied_at stored in EAT
    const [appResult] = await conn.execute(
      `INSERT INTO loan_applications
         (reference, user_id, product_id, amount_requested, tenure_months, purpose,
          employment_status, employer_name, monthly_income, guarantor, collateral_type,
          status, applied_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
      [reference, userId, product.id, amount, tenure_months, purpose,
       employment_status, employer_name || null, monthly_income,
       guarantor === 'true' ? 1 : 0, collateral_type || null, now]
    );
    const appId = appResult.insertId;

    // Save bank account
    const { encrypt } = require('../compliance/dataProtection');
    const encAccNum   = encrypt(account_number);
    await conn.execute(
      `INSERT INTO bank_accounts (user_id, bank_name, account_name, account_number_enc, branch, created_at)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE bank_name=VALUES(bank_name), account_name=VALUES(account_name),
         account_number_enc=VALUES(account_number_enc), branch=VALUES(branch)`,
      [userId, bank_name, account_name, encAccNum, bank_branch || null, now]
    );

    // Save/update next of kin
    await conn.execute(
      `INSERT INTO next_of_kin (user_id, full_name, relationship, phone, address, created_at)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), relationship=VALUES(relationship),
         phone=VALUES(phone), address=VALUES(address)`,
      [userId, kin_name, kin_relationship, kin_phone, kin_address || null, now]
    );

    // Save KYC documents
    const docTypeMap = {
      nid_front: 'nid_front', nid_back: 'nid_back',
      passport_photo: 'passport_photo', bank_statement: 'bank_statement',
      business_cert: 'business_cert', collateral_doc: 'collateral_doc',
    };
    if (req.files) {
      for (const [field, files] of Object.entries(req.files)) {
        const file     = files[0];
        const fileHash = crypto.createHash('sha256')
          .update(fs.readFileSync(file.path)).digest('hex');
        await conn.execute(
          `INSERT INTO kyc_documents (user_id, doc_type, file_path, file_hash, created_at)
           VALUES (?,?,?,?,?)`,
          [userId, docTypeMap[field] || 'other', file.path, fileHash, now]
        );
      }
    }

    // Record auto-debit mandate consent
    await conn.execute(
      `INSERT INTO consent_records (user_id, consent_type, granted, version, ip_address, user_agent, granted_at)
       VALUES (?,?,1,?,?,?,?)`,
      [userId, 'auto_debit_mandate', process.env.MANDATE_VERSION || '1.0',
       req.ip, req.headers['user-agent'] || '', now]
    );

    await conn.commit();

    // Preview installment for response
    const monthlyInstallment = calcInstallment(parseFloat(amount), product.monthly_rate, parseInt(tenure_months));

    // Send confirmation notifications
    const [userData] = await db.execute(
      'SELECT email, phone, first_name FROM users WHERE id = ?', [userId]
    );
    const u = userData[0];
    notif.sendSMS(u.phone,
      `Faster Loans Uganda: Your loan application ${reference} for UGX ${parseFloat(amount).toLocaleString()} has been received on ${now} (Uganda time). We will review and respond within 24 hours.`
    ).catch(() => {});
    notif.sendEmail(u.email, `Loan Application Received — ${reference}`, 'loan_applied', {
      name: u.first_name, reference, amount: parseFloat(amount).toLocaleString(),
      product: product.name, tenure: tenure_months,
      monthly_installment: monthlyInstallment.toLocaleString(),
      applied_at: now,
    }).catch(() => {});

    writeAudit({ actorId: userId, actorRole: 'customer', action: 'loan.applied',
      entity: 'loan_applications', entityId: appId,
      newValues: { reference, amount, tenure_months, product: product_code },
      ipAddress: req.ip });
    logger.info(`Loan applied: ${reference} by user ${userId} at ${now} EAT`);

    res.status(201).json({
      success: true,
      message: 'Loan application submitted successfully.',
      data: {
        reference,
        application_id: appId,
        product: product.name,
        amount_requested: parseFloat(amount),
        tenure_months: parseInt(tenure_months),
        monthly_installment: monthlyInstallment,
        monthly_rate_percent: (product.monthly_rate * 100).toFixed(2) + '%',
        deduction_day: 28,
        reminder_day: 25,
        status: 'pending',
        applied_at_eat: now,
        timezone: 'Africa/Kampala (EAT UTC+3)',
      },
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ── GET /api/loans/my-loans ───────────────────────────────────────
router.get('/my-loans', authenticate, async (req, res, next) => {
  try {
    const [apps] = await db.execute(
      `SELECT la.id, la.reference, lp.name AS product, la.amount_requested,
              la.tenure_months, la.status, la.applied_at, la.approved_at, la.disbursed_at,
              l.principal, l.monthly_installment, l.outstanding_balance, l.amount_paid,
              l.next_due_date, l.installments_paid, l.installments_remaining, l.status AS loan_status
       FROM loan_applications la
       JOIN loan_products lp ON lp.id = la.product_id
       LEFT JOIN loans l ON l.application_id = la.id
       WHERE la.user_id = ?
       ORDER BY la.applied_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, count: apps.length, loans: apps });
  } catch (err) { next(err); }
});

// ── GET /api/loans/:ref/schedule ─────────────────────────────────
router.get('/:ref/schedule', authenticate, async (req, res, next) => {
  try {
    const [appRows] = await db.execute(
      'SELECT id, user_id FROM loan_applications WHERE reference = ?', [req.params.ref]
    );
    if (!appRows.length) {
      return res.status(404).json({ success: false, message: 'Loan not found.' });
    }
    // Only owner or admin/officer
    const app = appRows[0];
    const isAdmin = ['admin','superadmin','officer'].includes(req.user.role);
    if (app.user_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const [loanRows] = await db.execute(
      'SELECT id FROM loans WHERE application_id = ?', [app.id]
    );
    if (!loanRows.length) {
      return res.status(404).json({ success: false, message: 'Loan not yet disbursed — no schedule available.' });
    }

    const [schedule] = await db.execute(
      `SELECT installment_no, due_date, reminder_date,
              principal_due, interest_due, total_due, balance_after,
              status, paid_amount, paid_at
       FROM repayment_schedule WHERE loan_id = ? ORDER BY installment_no`,
      [loanRows[0].id]
    );

    res.json({
      success: true,
      reference: req.params.ref,
      deduction_day: 28,
      reminder_day: 25,
      timezone: 'Africa/Kampala (EAT UTC+3)',
      schedule,
    });
  } catch (err) { next(err); }
});

// ── GET /api/loans/:ref ───────────────────────────────────────────
router.get('/:ref', authenticate, async (req, res, next) => {
  try {
    const isAdmin = ['admin','superadmin','officer'].includes(req.user.role);
    const whereUser = isAdmin ? '' : 'AND la.user_id = ?';
    const params    = isAdmin ? [req.params.ref] : [req.params.ref, req.user.id];

    const [rows] = await db.execute(
      `SELECT la.*, lp.name AS product_name, lp.monthly_rate,
              l.id AS loan_id, l.principal, l.monthly_installment, l.total_repayable,
              l.outstanding_balance, l.amount_paid, l.next_due_date,
              l.installments_paid, l.installments_remaining, l.status AS loan_status,
              l.disbursed_at
       FROM loan_applications la
       JOIN loan_products lp ON lp.id = la.product_id
       LEFT JOIN loans l ON l.application_id = la.id
       WHERE la.reference = ? ${whereUser}`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Loan application not found.' });
    }
    res.json({ success: true, loan: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /api/loans/:id/approve  (admin/officer) ─────────────────
router.patch('/:id/approve', authenticate, requireRole('officer','admin','superadmin'),
  auditMiddleware('loan.approved', 'loan_applications'),
  async (req, res, next) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const now = eatStr();
      const appId = parseInt(req.params.id);

      const [rows] = await conn.execute(
        `SELECT la.*, lp.monthly_rate, u.email, u.phone, u.first_name
         FROM loan_applications la
         JOIN loan_products lp ON lp.id = la.product_id
         JOIN users u ON u.id = la.user_id
         WHERE la.id = ? AND la.status IN ('pending','under_review')`,
        [appId]
      );
      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Application not found or not pending.' });
      }
      const app = rows[0];

      await conn.execute(
        `UPDATE loan_applications SET status='approved', officer_id=?, approved_at=? WHERE id=?`,
        [req.user.id, now, appId]
      );

      res.locals.auditEntityId = appId;
      res.locals.auditOld = { status: app.status };
      res.locals.auditNew = { status: 'approved', approved_at: now };

      await conn.commit();

      // Notify applicant
      notif.sendSMS(app.phone,
        `Faster Loans Uganda: CONGRATULATIONS! Your loan ${app.reference} for UGX ${parseFloat(app.amount_requested).toLocaleString()} has been APPROVED on ${now} (Uganda time). Funds will be disbursed to your bank account shortly.`
      ).catch(() => {});
      notif.sendEmail(app.email, `Loan Approved — ${app.reference}`, 'loan_approved', {
        name: app.first_name, reference: app.reference,
        amount: parseFloat(app.amount_requested).toLocaleString(),
        approved_at: now,
      }).catch(() => {});

      logger.info(`Loan approved: ${app.reference} by officer ${req.user.id} at ${now} EAT`);
      res.json({ success: true, message: 'Loan approved.', approved_at_eat: now });
    } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
  }
);

// ── PATCH /api/loans/:id/reject  (admin/officer) ──────────────────
router.patch('/:id/reject', authenticate, requireRole('officer','admin','superadmin'), [
  body('reason').trim().notEmpty().withMessage('Rejection reason required'),
], validate, async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const now   = eatStr();
    const appId = parseInt(req.params.id);

    const [rows] = await conn.execute(
      `SELECT la.reference, u.email, u.phone, u.first_name
       FROM loan_applications la JOIN users u ON u.id = la.user_id
       WHERE la.id = ? AND la.status IN ('pending','under_review')`,
      [appId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Application not found or not pending.' });
    }
    const app = rows[0];

    await conn.execute(
      `UPDATE loan_applications SET status='rejected', officer_id=?, rejection_reason=?,
       reviewed_at=? WHERE id=?`,
      [req.user.id, req.body.reason, now, appId]
    );
    await conn.commit();

    notif.sendSMS(app.phone,
      `Faster Loans Uganda: Your loan application ${app.reference} was not approved. Reason: ${req.body.reason}. Contact us on ${process.env.COMPANY_PHONE} for assistance.`
    ).catch(() => {});

    writeAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'loan.rejected',
      entity: 'loan_applications', entityId: appId,
      newValues: { status: 'rejected', reason: req.body.reason }, ipAddress: req.ip });
    logger.info(`Loan rejected: ${app.reference} at ${now} EAT`);
    res.json({ success: true, message: 'Loan rejected.', rejected_at_eat: now });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ── POST /api/loans/:id/disburse  (admin) ─────────────────────────
router.post('/:id/disburse', authenticate, requireRole('admin','superadmin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { v4: uuidv4 } = require('uuid');
    const now    = eatStr();
    const eatNow_ = eatNow();
    const appId  = parseInt(req.params.id);

    const [rows] = await conn.execute(
      `SELECT la.*, lp.monthly_rate, lp.name AS product_name,
              u.email, u.phone, u.first_name
       FROM loan_applications la
       JOIN loan_products lp ON lp.id = la.product_id
       JOIN users u ON u.id = la.user_id
       WHERE la.id = ? AND la.status = 'approved'`,
      [appId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Application not found or not approved.' });
    }
    const app = rows[0];

    const principal   = parseFloat(app.amount_requested);
    const rate        = parseFloat(app.monthly_rate);
    const months      = parseInt(app.tenure_months);
    const installment = calcInstallment(principal, rate, months);
    const totalRepay  = installment * months;

    // First due date: 28th of next month
    const firstDue = new Date(eatNow_);
    firstDue.setMonth(firstDue.getMonth() + 1);
    firstDue.setDate(28);

    // Insert loan record
    const [loanResult] = await conn.execute(
      `INSERT INTO loans
         (application_id, user_id, product_id, principal, monthly_rate, tenure_months,
          monthly_installment, total_repayable, outstanding_balance, deduction_day,
          next_due_date, installments_remaining, disbursed_at)
       VALUES (?,?,?,?,?,?,?,?,?,28,?,?,?)`,
      [appId, app.user_id, app.product_id, principal, rate, months,
       installment, totalRepay, principal,
       firstDue.toISOString().substring(0, 10), months, now]
    );
    const loanId = loanResult.insertId;

    // Generate & save repayment schedule
    const scheduleRows = buildSchedule(loanId, principal, rate, months, eatNow_);
    await saveSchedule(conn, scheduleRows);

    // Update application status
    await conn.execute(
      'UPDATE loan_applications SET status=\'disbursed\', disbursed_at=? WHERE id=?',
      [now, appId]
    );

    // Record disbursement transaction
    await conn.execute(
      `INSERT INTO transactions
         (uuid, loan_id, user_id, type, amount, currency, method, status, processed_at, created_at)
       VALUES (?,?,?,'disbursement',?,'UGX','bank_transfer','success',?,?)`,
      [uuidv4(), loanId, app.user_id, principal, now, now]
    );

    await conn.commit();

    // Notify
    notif.sendSMS(app.phone,
      `Faster Loans Uganda: UGX ${principal.toLocaleString()} has been disbursed to your bank account on ${now} (Uganda time). Ref: ${app.reference}. First repayment of UGX ${installment.toLocaleString()} due on ${firstDue.toISOString().substring(0, 10)}. Reminder on 25th.`
    ).catch(() => {});
    notif.sendEmail(app.email, `Loan Disbursed — ${app.reference}`, 'loan_disbursed', {
      name: app.first_name, reference: app.reference,
      amount: principal.toLocaleString(), installment: installment.toLocaleString(),
      first_due: firstDue.toISOString().substring(0, 10), disbursed_at: now,
    }).catch(() => {});

    writeAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'loan.disbursed',
      entity: 'loans', entityId: loanId,
      newValues: { principal, installment, first_due: firstDue.toISOString().substring(0, 10) },
      ipAddress: req.ip });
    logger.info(`Loan disbursed: ${app.reference} → UGX ${principal} at ${now} EAT`);

    res.json({
      success: true,
      message: 'Loan disbursed successfully.',
      data: {
        loan_id: loanId,
        reference: app.reference,
        principal,
        monthly_installment: installment,
        total_repayable: totalRepay,
        first_due_date: firstDue.toISOString().substring(0, 10),
        deduction_day: 28,
        reminder_day: 25,
        disbursed_at_eat: now,
        timezone: 'Africa/Kampala (EAT UTC+3)',
        installments: scheduleRows.length,
      },
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
