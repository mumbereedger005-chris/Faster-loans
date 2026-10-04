'use strict';
// services/notificationService.js
// SMS via Africa's Talking (Uganda)
// Email via Nodemailer (SMTP)
process.env.TZ = 'Africa/Kampala';

const nodemailer = require('nodemailer');
const db         = require('../db/db');
const logger     = require('./loggerService');

function eatNow()  { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function eatStr(d) { return (d || eatNow()).toISOString().replace('T',' ').substring(0,19); }

// ── Africa's Talking SMS (Uganda) ────────────────────────────────
let atSMS = null;
function getATSMS() {
  if (atSMS) return atSMS;
  try {
    const AfricasTalking = require('africastalking');
    const at = AfricasTalking({
      apiKey:   process.env.AT_API_KEY,
      username: process.env.AT_USERNAME || 'sandbox',
    });
    atSMS = at.SMS;
  } catch (err) {
    logger.warn('Africa\'s Talking SMS not initialised — check AT_API_KEY in .env');
    atSMS = null;
  }
  return atSMS;
}

// ── Nodemailer SMTP ───────────────────────────────────────────────
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });
  return transporter;
}

// ── Log notification to DB ────────────────────────────────────────
async function logNotification({ userId, channel, type, recipient, subject, body, status, errorMsg }) {
  try {
    const now = eatStr();
    await db.execute(
      `INSERT INTO notifications
         (user_id, channel, type, recipient, subject, body, status, sent_at, error_msg, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [userId, channel, type, recipient, subject || null, body,
       status, status === 'sent' ? now : null, errorMsg || null, now]
    );
  } catch (err) {
    logger.error('Failed to log notification', { error: err.message });
  }
}

// ── Send SMS ─────────────────────────────────────────────────────
/**
 * @param {string} phone     Uganda number, e.g. +256772123456
 * @param {string} message   Plain text SMS body (max 160 chars per segment)
 * @param {number} userId    For notification log
 * @param {string} type      e.g. 'payment_reminder'
 */
async function sendSMS(phone, message, userId = 0, type = 'general') {
  const now = eatStr();
  try {
    const sms = getATSMS();
    if (!sms) {
      logger.warn(`SMS SKIPPED (no AT config): TO=${phone} MSG="${message.substring(0,60)}..."`);
      await logNotification({ userId, channel:'sms', type, recipient:phone,
        body: message, status:'failed', errorMsg:'AT SMS not configured' });
      return;
    }
    const result = await sms.send({
      to:   [phone],
      message,
      from: process.env.AT_SENDER_ID || 'FasterLoans',
    });
    logger.info(`SMS sent to ${phone} at ${now} EAT`, { result: result.SMSMessageData?.Message });
    await logNotification({ userId, channel:'sms', type, recipient:phone, body:message, status:'sent' });
  } catch (err) {
    logger.error(`SMS failed to ${phone}`, { error: err.message });
    await logNotification({ userId, channel:'sms', type, recipient:phone,
      body:message, status:'failed', errorMsg: err.message });
  }
}

// ── Email Templates ───────────────────────────────────────────────
const COMPANY = () => process.env.COMPANY_NAME  || 'Faster Loans Uganda Limited';
const PHONE   = () => process.env.COMPANY_PHONE || '+256700123456';
const EMAIL   = () => process.env.COMPANY_EMAIL || 'info@fasterloans.co.ug';

function buildEmailHtml(title, bodyHtml) {
  const now = eatStr();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f5f7fa;margin:0;padding:20px}
  .card{max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.10)}
  .hdr{background:linear-gradient(135deg,#0f3d1e,#1a5c2e);padding:28px 32px;text-align:center}
  .hdr h1{color:#fff;font-size:1.3rem;margin:0}
  .hdr span{color:#f5a623;font-size:0.8rem}
  .body{padding:28px 32px;color:#1e2a3a;line-height:1.7}
  .body h2{font-size:1rem;color:#1a5c2e;margin-top:0}
  .highlight{background:#f0f9f4;border-left:4px solid #1a5c2e;padding:14px 18px;border-radius:0 8px 8px 0;margin:16px 0}
  .highlight .amount{font-size:1.5rem;font-weight:800;color:#1a5c2e}
  table.tbl{width:100%;border-collapse:collapse;margin:14px 0;font-size:0.88rem}
  table.tbl td{padding:8px 12px;border-bottom:1px solid #eef2f7}
  table.tbl td:first-child{color:#8a9ab0;width:45%}
  table.tbl td:last-child{font-weight:600}
  .btn{display:inline-block;background:#f5a623;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0}
  .footer{background:#f8fafc;padding:16px 32px;font-size:0.75rem;color:#8a9ab0;text-align:center;border-top:1px solid #eef2f7}
  .warn{background:#fff8e1;border-left:4px solid #f5a623;padding:12px 16px;border-radius:0 8px 8px 0;font-size:0.83rem;margin:12px 0}
</style></head>
<body>
<div class="card">
  <div class="hdr">
    <h1>🏦 ${COMPANY()}</h1>
    <span>Plot 42, Kampala Road, Kampala, Uganda</span>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="footer">
    📞 ${PHONE()} &nbsp;|&nbsp; ✉ ${EMAIL()}<br>
    Licensed by Uganda Microfinance Regulatory Authority (UMRA)<br>
    Regulated under the Data Protection and Privacy Act, Uganda 2019<br>
    <em>Sent on ${now} (Uganda Time — EAT UTC+3)</em>
  </div>
</div>
</body></html>`;
}

const templates = {
  welcome: (d) => ({
    subject: `Welcome to ${COMPANY()} — Verify Your Account`,
    html: buildEmailHtml('Welcome', `
      <h2>Welcome, ${d.name}! 🎉</h2>
      <p>Thank you for registering with <strong>${COMPANY()}</strong>. We're excited to help you access fast, transparent loans in Uganda.</p>
      <div class="highlight">
        <div>Your verification code:</div>
        <div class="amount" style="letter-spacing:6px">${d.otp}</div>
        <div style="font-size:0.8rem;color:#8a9ab0">Valid for 10 minutes. Do not share this code.</div>
      </div>
      <p>Enter this code on the verification page to activate your account.</p>
      <div class="warn">⚠ Never share your OTP. ${COMPANY()} staff will never ask for your PIN or OTP.</div>`),
  }),

  loan_applied: (d) => ({
    subject: `Loan Application Received — ${d.reference}`,
    html: buildEmailHtml('Application Received', `
      <h2>Loan Application Received ✅</h2>
      <p>Dear <strong>${d.name}</strong>, your loan application has been received successfully.</p>
      <table class="tbl">
        <tr><td>Reference</td><td>${d.reference}</td></tr>
        <tr><td>Product</td><td>${d.product}</td></tr>
        <tr><td>Amount Requested</td><td>UGX ${d.amount}</td></tr>
        <tr><td>Tenure</td><td>${d.tenure} months</td></tr>
        <tr><td>Est. Monthly Installment</td><td>UGX ${d.monthly_installment}</td></tr>
        <tr><td>Auto-Debit Day</td><td>28th of every month</td></tr>
        <tr><td>SMS Reminder Day</td><td>25th of every month</td></tr>
        <tr><td>Applied At (Uganda Time)</td><td>${d.applied_at}</td></tr>
      </table>
      <p>Our team will review your application and respond within <strong>24 hours</strong>. We'll notify you via SMS and email.</p>`),
  }),

  loan_approved: (d) => ({
    subject: `🎉 Loan Approved — ${d.reference}`,
    html: buildEmailHtml('Loan Approved', `
      <h2>Congratulations! Your Loan is Approved 🎉</h2>
      <p>Dear <strong>${d.name}</strong>, your loan application has been approved.</p>
      <div class="highlight">
        <div>Approved Amount:</div>
        <div class="amount">UGX ${d.amount}</div>
      </div>
      <table class="tbl">
        <tr><td>Reference</td><td>${d.reference}</td></tr>
        <tr><td>Approved At (Uganda Time)</td><td>${d.approved_at}</td></tr>
      </table>
      <p>Funds will be disbursed to your registered bank account shortly. You will receive another notification once the transfer is complete.</p>`),
  }),

  loan_disbursed: (d) => ({
    subject: `Loan Disbursed — UGX ${d.amount} Sent`,
    html: buildEmailHtml('Loan Disbursed', `
      <h2>Your Loan Has Been Disbursed 💰</h2>
      <p>Dear <strong>${d.name}</strong>, UGX ${d.amount} has been sent to your registered bank account.</p>
      <table class="tbl">
        <tr><td>Reference</td><td>${d.reference}</td></tr>
        <tr><td>Amount Disbursed</td><td>UGX ${d.amount}</td></tr>
        <tr><td>Monthly Installment</td><td>UGX ${d.installment}</td></tr>
        <tr><td>First Due Date</td><td>${d.first_due}</td></tr>
        <tr><td>Auto-Debit Day</td><td>28th of every month</td></tr>
        <tr><td>SMS Reminder</td><td>25th of every month (3 days before)</td></tr>
        <tr><td>Disbursed At (Uganda Time)</td><td>${d.disbursed_at}</td></tr>
      </table>
      <div class="warn">⚠ Ensure your ATM/debit card has sufficient funds by the 28th of every month to avoid penalties.</div>`),
  }),

  payment_reminder: (d) => ({
    subject: `Payment Reminder — UGX ${d.amount} Due on 28 ${d.month}`,
    html: buildEmailHtml('Payment Reminder', `
      <h2>📅 Upcoming Auto-Debit Reminder</h2>
      <p>Dear <strong>${d.name}</strong>, this is a reminder that your loan repayment will be automatically deducted on <strong>28 ${d.month}</strong>.</p>
      <div class="highlight">
        <div>Amount to be Debited:</div>
        <div class="amount">UGX ${d.amount}</div>
        <div style="font-size:0.8rem;color:#555">on 28 ${d.month} (Uganda Time)</div>
      </div>
      <table class="tbl">
        <tr><td>Loan Reference</td><td>${d.reference}</td></tr>
        <tr><td>Installment No.</td><td>${d.installment_no}</td></tr>
        <tr><td>Outstanding Balance After</td><td>UGX ${d.balance_after}</td></tr>
      </table>
      <div class="warn">⚠ Please ensure your card has at least UGX ${d.amount} available by 28 ${d.month}. Failed deductions may attract a penalty fee.</div>`),
  }),

  payment_success: (d) => ({
    subject: `Payment Confirmed — UGX ${d.amount} Received`,
    html: buildEmailHtml('Payment Success', `
      <h2>✅ Payment Confirmed</h2>
      <p>Dear <strong>${d.name}</strong>, your loan repayment has been received successfully.</p>
      <table class="tbl">
        <tr><td>Reference</td><td>${d.reference}</td></tr>
        <tr><td>Amount Paid</td><td>UGX ${d.amount}</td></tr>
        <tr><td>Transaction ID</td><td>${d.txn_id}</td></tr>
        <tr><td>Payment Date (Uganda Time)</td><td>${d.paid_at}</td></tr>
        <tr><td>Outstanding Balance</td><td>UGX ${d.balance}</td></tr>
        <tr><td>Next Due Date</td><td>${d.next_due || 'Loan Completed'}</td></tr>
      </table>
      <p>${d.balance <= 0 ? '🎉 <strong>Congratulations! Your loan is fully repaid.</strong>' : 'Thank you for your timely payment.'}</p>`),
  }),

  payment_failed: (d) => ({
    subject: `⚠ Payment Failed — Action Required`,
    html: buildEmailHtml('Payment Failed', `
      <h2>⚠ Auto-Debit Payment Failed</h2>
      <p>Dear <strong>${d.name}</strong>, we were unable to debit your card on 28 ${d.month}.</p>
      <div class="highlight" style="border-left-color:#e74c3c;background:#fff5f5">
        <div>Failed Amount:</div>
        <div class="amount" style="color:#e74c3c">UGX ${d.amount}</div>
        <div style="font-size:0.8rem;color:#e74c3c">Reason: ${d.reason}</div>
      </div>
      <div class="warn">⚠ Please update your card details or make payment manually within 3 days to avoid a late penalty. Contact us on ${PHONE()} immediately.</div>
      <a class="btn" href="${process.env.FRONTEND_URL || '#'}/payment.html">Update Card &amp; Pay Now</a>`),
  }),

  password_reset: (d) => ({
    subject: 'Password Reset — Faster Loans Uganda',
    html: buildEmailHtml('Password Reset', `
      <h2>Password Reset Request 🔐</h2>
      <p>Dear <strong>${d.name}</strong>, here is your password reset code:</p>
      <div class="highlight">
        <div class="amount" style="letter-spacing:6px">${d.otp}</div>
        <div style="font-size:0.8rem;color:#8a9ab0">Valid for 15 minutes.</div>
      </div>
      <div class="warn">⚠ If you did not request a password reset, please contact us immediately on ${PHONE()}.</div>`),
  }),
};

// ── Send Email ────────────────────────────────────────────────────
/**
 * @param {string} to          Recipient email
 * @param {string} subject     Fallback subject (overridden by template)
 * @param {string} templateKey Key in templates object
 * @param {object} data        Data for template
 * @param {number} userId      For notification log
 */
async function sendEmail(to, subject, templateKey, data = {}, userId = 0) {
  try {
    const tpl     = templates[templateKey] ? templates[templateKey](data) : null;
    const subj    = tpl?.subject || subject;
    const html    = tpl?.html    || `<p>${subject}</p>`;
    const now     = eatStr();

    await getTransporter().sendMail({
      from:    process.env.EMAIL_FROM || `"${COMPANY()}" <noreply@fasterloans.co.ug>`,
      to,
      subject: subj,
      html,
    });

    logger.info(`Email sent to ${to} [${templateKey}] at ${now} EAT`);
    await logNotification({ userId, channel:'email', type:templateKey,
      recipient:to, subject:subj, body:html, status:'sent' });
  } catch (err) {
    logger.error(`Email failed to ${to} [${templateKey}]`, { error: err.message });
    await logNotification({ userId, channel:'email', type:templateKey,
      recipient:to, subject, body: JSON.stringify(data), status:'failed', errorMsg: err.message });
  }
}

// ── Convenience: send both SMS + email ───────────────────────────
async function notify(phone, email, smsBody, templateKey, templateData, userId = 0) {
  await Promise.allSettled([
    sendSMS(phone, smsBody, userId, templateKey),
    sendEmail(email, '', templateKey, templateData, userId),
  ]);
}

module.exports = { sendSMS, sendEmail, notify };
