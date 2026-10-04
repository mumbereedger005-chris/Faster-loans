'use strict';
// services/loanService.js — Amortization, schedule generation, balance updates
process.env.TZ = 'Africa/Kampala';

/**
 * Uganda EAT helpers
 */
function eatNow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}
function eatStr(d) {
  return (d || eatNow()).toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Generate a loan reference: FL-YYYY-XXXX using Uganda year
 */
function generateRef() {
  const year = eatNow().getFullYear();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `FL-${year}-${rand}`;
}

/**
 * Reducing-balance monthly installment (EMI formula)
 * @param {number} principal  – loan amount in UGX
 * @param {number} rate       – monthly rate as decimal e.g. 0.035
 * @param {number} months     – tenure in months
 * @returns {number} monthly installment rounded to nearest UGX
 */
function calcInstallment(principal, rate, months) {
  if (rate === 0) return Math.round(principal / months);
  const r = rate;
  const n = months;
  return Math.round(principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
}

/**
 * Build full amortization schedule.
 * Due date: always 28th of each month (Uganda deduction day).
 * Reminder: always 25th (3 days before).
 *
 * @param {number} loanId
 * @param {number} principal
 * @param {number} rate          – monthly decimal rate
 * @param {number} months
 * @param {Date}   startDate     – EAT date of disbursement
 * @returns {Array} rows ready for INSERT into repayment_schedule
 */
function buildSchedule(loanId, principal, rate, months, startDate) {
  const installment = calcInstallment(principal, rate, months);
  let balance = principal;
  const rows  = [];

  for (let i = 1; i <= months; i++) {
    const interest  = Math.round(balance * rate);
    const princ     = i < months ? installment - interest : balance; // last payment clears balance
    const totalDue  = princ + interest;
    balance         = Math.max(0, Math.round(balance - princ));

    // Due date: 28th of (startDate.month + i)
    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + i);
    dueDate.setDate(28);

    // Reminder: 25th of same month
    const reminderDate = new Date(dueDate);
    reminderDate.setDate(25);

    rows.push({
      loan_id:        loanId,
      installment_no: i,
      due_date:       dueDate.toISOString().substring(0, 10),
      reminder_date:  reminderDate.toISOString().substring(0, 10),
      principal_due:  princ,
      interest_due:   interest,
      total_due:      totalDue,
      balance_after:  balance,
      status:         'pending',
    });
  }
  return rows;
}

/**
 * Persist repayment schedule rows into DB.
 */
async function saveSchedule(conn, rows) {
  for (const r of rows) {
    await conn.execute(
      `INSERT INTO repayment_schedule
         (loan_id, installment_no, due_date, reminder_date,
          principal_due, interest_due, total_due, balance_after, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.loan_id, r.installment_no, r.due_date, r.reminder_date,
       r.principal_due, r.interest_due, r.total_due, r.balance_after, r.status]
    );
  }
}

/**
 * After a successful repayment, update loan balance and next_due_date.
 */
async function applyRepayment(conn, loanId, scheduleId, paidAmount) {
  const now = eatStr();

  // Mark schedule installment paid/partial
  const [sched] = await conn.execute(
    'SELECT * FROM repayment_schedule WHERE id = ?', [scheduleId]
  );
  if (!sched.length) throw new Error('Schedule row not found');
  const s = sched[0];

  const newPaid  = parseFloat(s.paid_amount) + parseFloat(paidAmount);
  const newStatus = newPaid >= parseFloat(s.total_due) ? 'paid' : 'partial';

  await conn.execute(
    `UPDATE repayment_schedule
     SET paid_amount = ?, status = ?, paid_at = ?
     WHERE id = ?`,
    [newPaid, newStatus, now, scheduleId]
  );

  // Update loan ledger
  const [loanRows] = await conn.execute('SELECT * FROM loans WHERE id = ?', [loanId]);
  const loan = loanRows[0];
  const newBalance = Math.max(0, parseFloat(loan.outstanding_balance) - parseFloat(paidAmount));
  const newAmtPaid = parseFloat(loan.amount_paid) + parseFloat(paidAmount);
  const instPaid   = parseInt(loan.installments_paid) + (newStatus === 'paid' ? 1 : 0);
  const instRem    = parseInt(loan.installments_remaining) - (newStatus === 'paid' ? 1 : 0);
  const loanStatus = newBalance <= 0 ? 'completed' : 'active';

  // Find next due date
  const [nextSched] = await conn.execute(
    `SELECT due_date FROM repayment_schedule
     WHERE loan_id = ? AND status IN ('pending','partial') ORDER BY installment_no LIMIT 1`,
    [loanId]
  );
  const nextDue = nextSched.length ? nextSched[0].due_date : null;

  await conn.execute(
    `UPDATE loans SET outstanding_balance = ?, amount_paid = ?, installments_paid = ?,
     installments_remaining = ?, next_due_date = ?, status = ?,
     completed_at = ?
     WHERE id = ?`,
    [newBalance, newAmtPaid, instPaid, Math.max(0, instRem),
     nextDue, loanStatus,
     loanStatus === 'completed' ? now : null,
     loanId]
  );

  return { newBalance, loanStatus };
}

module.exports = { eatNow, eatStr, generateRef, calcInstallment, buildSchedule, saveSchedule, applyRepayment };
