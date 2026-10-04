'use strict';
// scheduler/autoDebit.js
// ─────────────────────────────────────────────────────────────────
//  TWO CRON JOBS running in Uganda EAT (Africa/Kampala UTC+3):
//
//  JOB 1 — 25th of every month at 08:00 EAT
//           → Send SMS + email reminder to every customer whose
//             28th installment is coming up in 3 days.
//
//  JOB 2 — 28th of every month at 07:00 EAT
//           → Execute auto-debit for every active installment due today.
//           → On success: apply repayment to loan ledger, notify customer.
//           → On failure: mark failed, notify customer + admin.
//           → Retry failed once at 14:00 EAT same day.
//
//  JOB 3 — Every hour: verify any pending transactions still open.
// ─────────────────────────────────────────────────────────────────
process.env.TZ = 'Africa/Kampala';

const cron   = require('node-cron');
const db     = require('../db/db');
const logger = require('../services/loggerService');
const notif  = require('../services/notificationService');
const { executeAutoDebit, verifyTransaction } = require('../services/paymentService');
const { applyRepayment }  = require('../services/loanService');
const { writeAuditEntry } = require('../compliance/dataProtection');

// ── EAT helpers ──────────────────────────────────────────────────
function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T', ' ').substring(0, 19); }
function eatDateStr(d) { return (d || eatNow()).toISOString().substring(0, 10); }

/** Format month name for messages, e.g. "October 2026" */
function monthLabel(d) {
  return (d || eatNow()).toLocaleString('en-UG', {
    timeZone: 'Africa/Kampala', month: 'long', year: 'numeric',
  });
}

// ═══════════════════════════════════════════════════════════════════
//  JOB 1  — PAYMENT REMINDER  (25th at 08:00 EAT)
// ═══════════════════════════════════════════════════════════════════
async function runReminderJob() {
  const now       = eatStr();
  const todayEAT  = eatDateStr();
  logger.info(`[SCHEDULER] Reminder job started at ${now} EAT`);

  try {
    // Find all installments whose reminder_date is today (25th)
    const [schedules] = await db.execute(`
      SELECT rs.id AS schedule_id, rs.installment_no,
             rs.due_date, rs.total_due, rs.balance_after,
             l.id AS loan_id,
             la.reference,
             u.id AS user_id, u.first_name, u.email, u.phone
      FROM repayment_schedule rs
      JOIN loans l               ON l.id  = rs.loan_id
      JOIN loan_applications la  ON la.id = l.application_id
      JOIN users u               ON u.id  = l.user_id
      WHERE rs.reminder_date = ?
        AND rs.status        IN ('pending', 'partial')
        AND rs.reminder_sent = 0
        AND l.status         = 'active'
        AND u.is_active      = 1
    `, [todayEAT]);

    logger.info(`[SCHEDULER] Reminder: ${schedules.length} installment(s) to remind`);

    for (const s of schedules) {
      const month  = monthLabel(new Date(s.due_date));
      const amount = parseFloat(s.total_due).toLocaleString();
      const balAfter = parseFloat(s.balance_after).toLocaleString();

      // SMS
      await notif.sendSMS(s.phone,
        `Faster Loans Uganda: REMINDER — UGX ${amount} will be auto-debited from your card on 28 ${month} for loan ${s.reference} (Installment ${s.installment_no}). Ensure your card has sufficient funds. Call ${process.env.COMPANY_PHONE || '+256700123456'} for help.`,
        s.user_id, 'payment_reminder'
      );

      // Email
      await notif.sendEmail(s.email, `Payment Reminder — 28 ${month}`, 'payment_reminder', {
        name:           s.first_name,
        reference:      s.reference,
        amount,
        month,
        installment_no: s.installment_no,
        balance_after:  balAfter,
      }, s.user_id);

      // Mark reminder sent
      await db.execute(
        'UPDATE repayment_schedule SET reminder_sent = 1 WHERE id = ?',
        [s.schedule_id]
      );

      logger.info(`[SCHEDULER] Reminder sent to ${s.phone} for loan ${s.reference} installment ${s.installment_no}`);
    }

    await writeAuditEntry({
      action:     'scheduler.reminder_job',
      entity:     'repayment_schedule',
      newValues:  { ran_at: now, reminders_sent: schedules.length },
    });

    logger.info(`[SCHEDULER] Reminder job done at ${eatStr()} EAT — ${schedules.length} sent`);
  } catch (err) {
    logger.error('[SCHEDULER] Reminder job error', { error: err.message, stack: err.stack });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  JOB 2  — AUTO-DEBIT EXECUTION  (28th at 07:00 EAT + retry 14:00)
// ═══════════════════════════════════════════════════════════════════
async function runDebitJob(isRetry = false) {
  const now      = eatStr();
  const todayEAT = eatDateStr();
  logger.info(`[SCHEDULER] Auto-debit job ${isRetry ? '(RETRY) ' : ''}started at ${now} EAT`);

  let processed = 0, succeeded = 0, failed = 0;

  try {
    // For retry: only pick up schedules that failed this morning
    const statusFilter = isRetry ? "AND rs.status = 'partial'" : "AND rs.status IN ('pending','partial')";

    const [schedules] = await db.execute(`
      SELECT rs.id AS schedule_id, rs.installment_no,
             rs.total_due, rs.paid_amount, rs.due_date,
             l.id    AS loan_id,
             l.user_id,
             l.monthly_installment,
             la.reference,
             u.first_name, u.email, u.phone
      FROM repayment_schedule rs
      JOIN loans l               ON l.id  = rs.loan_id
      JOIN loan_applications la  ON la.id = l.application_id
      JOIN users u               ON u.id  = l.user_id
      WHERE rs.due_date = ?
        ${statusFilter}
        AND l.status  = 'active'
        AND u.is_active = 1
    `, [todayEAT]);

    logger.info(`[SCHEDULER] Auto-debit: ${schedules.length} installment(s) to process`);

    for (const s of schedules) {
      processed++;
      const month  = monthLabel(new Date(s.due_date));
      const amount = parseFloat(s.total_due).toLocaleString();

      try {
        // Execute debit via payment provider
        const result = await executeAutoDebit(
          { id: s.loan_id, user_id: s.user_id, monthly_installment: s.monthly_installment },
          { id: s.schedule_id, installment_no: s.installment_no, total_due: s.total_due }
        );

        if (result.status === 'success') {
          // ── SUCCESS ─────────────────────────────────────────────
          succeeded++;

          // Apply repayment to loan ledger
          const conn = await db.getConnection();
          let newBalance = 0;
          let loanStatus = 'active';
          try {
            await conn.beginTransaction();
            const repResult = await applyRepayment(
              conn, s.loan_id, s.schedule_id, parseFloat(s.total_due)
            );
            newBalance = repResult.newBalance;
            loanStatus = repResult.loanStatus;
            await conn.commit();
          } catch (e) {
            await conn.rollback();
            logger.error(`[SCHEDULER] applyRepayment failed loan ${s.loan_id}`, { error: e.message });
          } finally { conn.release(); }

          // Get updated next due date
          const [nxt] = await db.execute(
            `SELECT due_date FROM repayment_schedule
             WHERE loan_id = ? AND status IN ('pending','partial')
             ORDER BY installment_no LIMIT 1`, [s.loan_id]
          );

          // Notify success
          const smsMsg = loanStatus === 'completed'
            ? `Faster Loans Uganda: UGX ${amount} has been auto-debited successfully on ${now} (Uganda time) for loan ${s.reference}. 🎉 Congratulations — your loan is FULLY REPAID! Thank you.`
            : `Faster Loans Uganda: UGX ${amount} has been auto-debited successfully on ${now} (Uganda time) for loan ${s.reference}. Balance: UGX ${parseFloat(newBalance).toLocaleString()}. Next debit: 28th.`;

          await notif.sendSMS(s.phone, smsMsg, s.user_id, 'payment_success');
          await notif.sendEmail(s.email, 'Payment Confirmed', 'payment_success', {
            name:      s.first_name,
            reference: s.reference,
            amount,
            txn_id:    result.txnUuid,
            paid_at:   now,
            balance:   parseFloat(newBalance).toLocaleString(),
            next_due:  nxt[0]?.due_date || null,
          }, s.user_id);

          logger.info(`[SCHEDULER] ✅ Debit SUCCESS: loan ${s.reference}, UGX ${amount} at ${now} EAT`);

        } else {
          // ── FAILED ──────────────────────────────────────────────
          failed++;

          // Notify customer
          await notif.sendSMS(s.phone,
            `URGENT — Faster Loans Uganda: Auto-debit of UGX ${amount} FAILED for loan ${s.reference} on ${now} (Uganda time). Reason: ${result.message || 'Insufficient funds or card issue'}. Please update your card or contact us on ${process.env.COMPANY_PHONE} immediately.`,
            s.user_id, 'payment_failed'
          );
          await notif.sendEmail(s.email, '⚠ Payment Failed — Action Required', 'payment_failed', {
            name:      s.first_name,
            reference: s.reference,
            amount,
            month,
            reason:    result.message || 'Card declined or insufficient funds',
          }, s.user_id);

          // Alert admin by email
          await notif.sendEmail(
            process.env.SMTP_USER || process.env.COMPANY_EMAIL,
            `[ADMIN ALERT] Auto-debit FAILED — ${s.reference}`,
            'payment_failed',
            {
              name:      'Admin',
              reference: s.reference,
              amount,
              month,
              reason:    result.message || 'Unknown',
            }
          );

          logger.warn(`[SCHEDULER] ❌ Debit FAILED: loan ${s.reference}, UGX ${amount} — ${result.message}`);
        }

        await writeAuditEntry({
          action:    `scheduler.auto_debit.${result.status}`,
          entity:    'repayment_schedule',
          entityId:  s.schedule_id,
          newValues: { loan_id: s.loan_id, amount: s.total_due, status: result.status, ran_at: now },
        });

      } catch (itemErr) {
        failed++;
        logger.error(`[SCHEDULER] Debit error for schedule ${s.schedule_id}`, {
          error: itemErr.message, loan: s.reference,
        });
      }

      // Small delay between charges to avoid rate limits
      await new Promise(r => setTimeout(r, 800));
    }

    await writeAuditEntry({
      action:    'scheduler.debit_job',
      newValues: { ran_at: now, is_retry: isRetry, processed, succeeded, failed },
    });

    logger.info(
      `[SCHEDULER] Auto-debit job done at ${eatStr()} EAT — ` +
      `processed: ${processed}, succeeded: ${succeeded}, failed: ${failed}`
    );
  } catch (err) {
    logger.error('[SCHEDULER] Auto-debit job fatal error', { error: err.message, stack: err.stack });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  JOB 3  — VERIFY PENDING TRANSACTIONS  (every hour)
// ═══════════════════════════════════════════════════════════════════
async function runVerifyJob() {
  const now = eatStr();
  try {
    // Find transactions pending > 5 minutes
    const [pending] = await db.execute(`
      SELECT uuid, loan_id, schedule_id, user_id, amount
      FROM transactions
      WHERE status = 'pending'
        AND provider_ref IS NOT NULL
        AND created_at <= DATE_SUB(CONVERT_TZ(NOW(),'+00:00','+03:00'), INTERVAL 5 MINUTE)
      LIMIT 50
    `);

    if (!pending.length) return;
    logger.info(`[SCHEDULER] Verify job: ${pending.length} pending transaction(s) at ${now} EAT`);

    for (const txn of pending) {
      try {
        const result = await verifyTransaction(txn.uuid);
        if (result.status === 'success' && result.updated && txn.loan_id && txn.schedule_id) {
          const conn = await db.getConnection();
          try {
            await conn.beginTransaction();
            await applyRepayment(conn, txn.loan_id, txn.schedule_id, txn.amount);
            await conn.commit();
            logger.info(`[SCHEDULER] Verify recovered payment: txn ${txn.uuid}`);
          } catch (e) {
            await conn.rollback();
          } finally { conn.release(); }
        }
      } catch (e) {
        logger.error(`[SCHEDULER] Verify error txn ${txn.uuid}`, { error: e.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (err) {
    logger.error('[SCHEDULER] Verify job error', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  REGISTER CRON JOBS
//  All times are in Africa/Kampala (EAT, UTC+3)
//  node-cron uses server local time — process.env.TZ = 'Africa/Kampala'
// ═══════════════════════════════════════════════════════════════════
function startScheduler() {
  logger.info('[SCHEDULER] Initialising cron jobs in Uganda EAT timezone...');

  // JOB 1 — 25th of every month at 08:00 EAT
  cron.schedule('0 8 25 * *', () => {
    logger.info('[SCHEDULER] Cron fired: 25th reminder job');
    runReminderJob();
  }, { timezone: 'Africa/Kampala' });

  // JOB 2a — 28th of every month at 07:00 EAT (first run)
  cron.schedule('0 7 28 * *', () => {
    logger.info('[SCHEDULER] Cron fired: 28th auto-debit job (first run)');
    runDebitJob(false);
  }, { timezone: 'Africa/Kampala' });

  // JOB 2b — 28th of every month at 14:00 EAT (retry failed)
  cron.schedule('0 14 28 * *', () => {
    logger.info('[SCHEDULER] Cron fired: 28th auto-debit job (retry)');
    runDebitJob(true);
  }, { timezone: 'Africa/Kampala' });

  // JOB 3 — Every hour on the hour
  cron.schedule('0 * * * *', () => {
    runVerifyJob();
  }, { timezone: 'Africa/Kampala' });

  logger.info('[SCHEDULER] Cron jobs registered:');
  logger.info('  → 25th 08:00 EAT : Payment reminders (SMS + email)');
  logger.info('  → 28th 07:00 EAT : Auto-debit (first attempt)');
  logger.info('  → 28th 14:00 EAT : Auto-debit (retry failed)');
  logger.info('  → Hourly          : Verify pending transactions');
}

// ── Manual trigger exports (for testing / admin endpoints) ───────
module.exports = {
  startScheduler,
  runReminderJob,
  runDebitJob,
  runVerifyJob,
};
