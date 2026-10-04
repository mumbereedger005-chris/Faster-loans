# 🏦 Faster Loans Uganda — Backend API

**Node.js / Express** backend for Faster Loans Uganda Limited.  
Handles loan applications, auto-debit repayments, SMS/email notifications, admin dashboard, security, and full PDPA Uganda 2019 compliance.

---

## 📁 Project Structure

```
backend/
├── server.js                   ← Express app entry point
├── package.json                ← Dependencies
├── .env.example                ← Copy to .env and fill in values
│
├── db/
│   ├── db.js                   ← MySQL connection pool
│   ├── schema.sql              ← Full database schema (EAT timezone)
│   └── migrate.js              ← Run schema against MySQL
│
├── middleware/
│   ├── auth.js                 ← JWT Bearer token verification
│   ├── rbac.js                 ← Role-based access control
│   ├── validate.js             ← express-validator result handler
│   ├── errorHandler.js         ← Central error handler (no stack leaks)
│   └── auditLog.js             ← Immutable audit trail writer
│
├── routes/
│   ├── auth.js                 ← Register, login, OTP, password reset
│   ├── loans.js                ← Apply, approve, disburse, schedule
│   ├── payments.js             ← Card mandate, webhook, verify, history
│   └── admin.js                ← Dashboard, customers, reports
│
├── services/
│   ├── loggerService.js        ← Winston logger (EAT timestamps)
│   ├── loanService.js          ← Amortization, schedule builder, ledger
│   ├── notificationService.js  ← SMS (Africa's Talking) + Email (SMTP)
│   └── paymentService.js       ← Pesapal + Flutterwave integration
│
├── scheduler/
│   └── autoDebit.js            ← Cron: 25th reminder, 28th debit, hourly verify
│
└── compliance/
    └── dataProtection.js       ← AES-256 encrypt, PDPA consent, audit
```

---

## ⚙️ Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18.x or higher |
| MySQL | 8.0 or higher |
| npm | 9.x or higher |

---

## 🚀 Setup — Step by Step

### 1. Install Dependencies

Open a terminal inside the `backend/` folder and run:

```bash
npm install
```

---

### 2. Configure Environment Variables

Copy the example file and fill in your real values:

```bash
# Windows PowerShell
Copy-Item .env.example .env
```

Then open `.env` and update every value:

```env
# ── Server ────────────────────────────────────────────────
NODE_ENV=development
PORT=5000
FRONTEND_URL=http://localhost:3000
TZ=Africa/Kampala          ← Uganda EAT — DO NOT CHANGE

# ── MySQL Database ────────────────────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=faster_loans

# ── JWT Secrets (use long random strings) ────────────────
JWT_SECRET=at_least_64_random_characters_here
JWT_REFRESH_SECRET=another_64_random_characters_here

# ── AES-256 Encryption ────────────────────────────────────
ENCRYPTION_KEY=64_hex_characters_for_32_byte_key
ENCRYPTION_IV=32_hex_characters_for_16_byte_iv

# ── Africa's Talking SMS (Uganda) ────────────────────────
AT_API_KEY=your_key
AT_USERNAME=sandbox         ← change to your username in production
AT_SENDER_ID=FasterLoans

# ── Email (Gmail example) ─────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_password

# ── Pesapal (primary payment) ─────────────────────────────
PESAPAL_CONSUMER_KEY=your_key
PESAPAL_CONSUMER_SECRET=your_secret
PESAPAL_ENV=sandbox

# ── Flutterwave (fallback) ────────────────────────────────
FLW_PUBLIC_KEY=FLWPUBK-xxxx
FLW_SECRET_KEY=FLWSECK-xxxx
FLW_WEBHOOK_HASH=your_hash

# ── Company Details ───────────────────────────────────────
COMPANY_NAME=Faster Loans Uganda Limited
COMPANY_PHONE=+256700123456
COMPANY_EMAIL=info@fasterloans.co.ug
```

> **Generating secure secrets (PowerShell):**
> ```powershell
> # 64-char JWT secret
> -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
>
> # 64-char hex encryption key
> -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
>
> # 32-char hex IV
> -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
> ```

---

### 3. Create the Database

Open MySQL (Workbench, HeidiSQL, or CLI) and run:

```sql
-- Option A: paste directly
SOURCE path/to/backend/db/schema.sql;

-- Option B: use the migrate script (from backend/ folder)
node db/migrate.js
```

The migrate script will:
- Create the `faster_loans` database if it doesn't exist
- Create all 15 tables with Uganda EAT timezone defaults
- Seed the 6 loan products
- Print the current Uganda time to confirm timezone is correct

---

### 4. Start the Server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

You should see:

```
✅  MySQL connected – faster_loans
🚀  Faster Loans Uganda API running on port 5000
🕐  Uganda Time (EAT): 2026-09-27 09:45:12
🌍  Environment: development
[SCHEDULER] Cron jobs registered:
  → 25th 08:00 EAT : Payment reminders (SMS + email)
  → 28th 07:00 EAT : Auto-debit (first attempt)
  → 28th 14:00 EAT : Auto-debit (retry failed)
  → Hourly          : Verify pending transactions
```

---

### 5. Test the API

#### Health check (confirms Uganda time):
```
GET http://localhost:5000/api/health
GET http://localhost:5000/api/clock
```

#### Register a customer:
```
POST http://localhost:5000/api/auth/register
Content-Type: application/json

{
  "first_name": "Nakamya",
  "last_name": "Prossy",
  "email": "nakamya@example.com",
  "phone": "0772123456",
  "password": "Password123"
}
```

#### Login:
```
POST http://localhost:5000/api/auth/login
Content-Type: application/json

{
  "email": "nakamya@example.com",
  "password": "Password123"
}
```

Use the returned `access_token` as `Authorization: Bearer <token>` on all protected routes.

---

## 📡 API Reference

### Authentication (`/api/auth`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/register` | None | Register customer, send OTP |
| POST | `/verify-otp` | None | Verify phone OTP |
| POST | `/login` | None | Login, returns JWT |
| POST | `/refresh` | None | Refresh access token |
| POST | `/logout` | ✅ | Revoke refresh token |
| POST | `/forgot-password` | None | Send reset OTP via SMS |
| POST | `/reset-password` | None | Reset password with OTP |
| GET  | `/me` | ✅ | Get own profile |

### Loans (`/api/loans`)

| Method | Endpoint | Auth | Role | Description |
|---|---|---|---|---|
| POST | `/apply` | ✅ | customer | Submit loan application + scan docs |
| GET  | `/my-loans` | ✅ | customer | List own loans |
| GET  | `/:ref` | ✅ | any | Get loan detail |
| GET  | `/:ref/schedule` | ✅ | any | Repayment schedule (28th dates) |
| PATCH | `/:id/approve` | ✅ | officer+ | Approve application |
| PATCH | `/:id/reject` | ✅ | officer+ | Reject with reason |
| POST | `/:id/disburse` | ✅ | admin+ | Disburse and generate schedule |

### Payments (`/api/payments`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/mandate` | ✅ | Register card for auto-debit |
| DELETE | `/mandate/:loanId` | ✅ | Revoke card mandate |
| POST | `/verify` | ✅ | Verify transaction status |
| POST | `/webhook/pesapal` | None | Pesapal IPN callback |
| POST | `/webhook/flutterwave` | None | Flutterwave webhook |
| GET  | `/history` | ✅ | Payment transaction history |

### Admin (`/api/admin`) — Requires officer/admin role

| Method | Endpoint | Description |
|---|---|---|
| GET | `/dashboard` | KPI stats + monthly trend (Uganda time) |
| GET | `/customers` | Paginated customer list with search |
| GET | `/customers/:id` | Full customer detail + loans |
| PATCH | `/customers/:id/status` | Activate / deactivate customer |
| GET | `/applications` | All loan applications (filterable) |
| GET | `/loans` | All live loans (filterable) |
| GET | `/overdue` | Overdue installments with contacts |
| POST | `/overdue/:scheduleId/notify` | Send overdue SMS manually |
| GET | `/transactions` | All transactions (filterable) |
| GET | `/reports/summary` | Monthly report (Uganda calendar) |
| GET | `/reports/audit-log` | Full immutable audit trail |
| GET | `/notifications` | All SMS/email notification logs |
| POST | `/loans/:id/write-off` | Write off a defaulted loan |

---

## 🕐 Uganda Time (EAT) — How It Works

Every timestamp in this system is stored and displayed in **Africa/Kampala (EAT = UTC+3)**. Here is how it is enforced at every layer:

| Layer | How |
|---|---|
| **Node.js process** | `process.env.TZ = 'Africa/Kampala'` in every file |
| **MySQL** | `SET time_zone = '+03:00'` in schema; `CONVERT_TZ(NOW(),'+00:00','+03:00')` on every `DEFAULT` |
| **Application dates** | `eatNow()` helper: `new Date(Date.now() + 3*60*60*1000)` |
| **API responses** | Every response includes `*_at_eat` fields and `"timezone":"Africa/Kampala (EAT UTC+3)"` |
| **Loan application** | `applied_at` saved in EAT — exact Uganda time the customer submitted |
| **Repayment schedule** | `due_date` always 28th, `reminder_date` always 25th of each month |
| **Cron jobs** | All registered with `{ timezone: 'Africa/Kampala' }` |
| **Logger** | Winston timestamps formatted with `+03:00` offset |

---

## 🔒 Security Features

| Feature | Implementation |
|---|---|
| HTTPS enforcement | Redirects HTTP → HTTPS in production |
| Security headers | Helmet.js (CSP, HSTS, X-Frame-Options, etc.) |
| Rate limiting | 100 req/15min global; 10 req/15min on auth endpoints |
| JWT authentication | Access token (15 min) + Refresh token (7 days, DB-stored) |
| Password hashing | bcrypt with cost factor 12 |
| Account lockout | 5 failed logins → 30-min lock |
| Role-based access | customer / officer / admin / superadmin hierarchy |
| Sensitive data encryption | AES-256-CBC for account numbers and card tokens |
| Card data | Only last 4 digits + tokenised reference stored — never raw PAN |
| Audit trail | Immutable `audit_logs` table for every state change |
| CORS | Restricted to allowed origins in production |
| Input validation | express-validator on every route |
| Error handling | No stack traces exposed to clients in production |
| SQL injection | Parameterised queries via mysql2 — no string interpolation |
| File uploads | Type + size validated; not served publicly without auth |

---

## 📲 Automatic Repayment Schedule

```
Every month:
  25th — 08:00 EAT  →  SMS + email reminder sent to each customer
  28th — 07:00 EAT  →  Auto-debit first attempt (Flutterwave card token)
  28th — 14:00 EAT  →  Retry any failed debits from morning
  Hourly            →  Verify any "pending" transactions still open
```

**What happens on success:**
- Transaction marked `success`
- Loan ledger updated (outstanding balance reduced)
- Repayment schedule installment marked `paid`
- Customer notified via SMS + email
- If fully repaid: loan marked `completed`, congratulations SMS sent

**What happens on failure:**
- Transaction marked `failed`
- Customer notified with reason + instructions
- Admin alerted by email
- Retried once at 14:00 EAT same day
- If still failing: loan officer follows up manually via admin dashboard

---

## ⚖️ Legal & Regulatory Compliance (Uganda)

| Requirement | How It's Met |
|---|---|
| **PDPA Uganda 2019** | Consent recorded before any data use; `consent_records` table; right-to-erasure via `anonymiseUser()`; encrypted storage |
| **Customer Authorisation** | Explicit auto-debit consent checkbox in apply form; stored in `consent_records` with IP, user agent, timestamp |
| **UMRA Licensing** | Footer and emails state "Licensed by UMRA"; compliance data retained per regulations |
| **BOU Interest Rates** | Rates seeded in `loan_products` aligned to BOU CBR (2026 benchmarks) |
| **Audit Trail** | Every state change logged to `audit_logs` with actor, timestamp (EAT), old + new values |
| **Data Retention** | `anonymiseUser()` function for post-retention PDPA compliance |
| **Transaction Records** | Full history in `transactions` table; immutable once written |
| **Repayment Disclosure** | Full schedule shown to customer before acceptance; `applied_at` in EAT on all records |
| **Notification of Deduction** | SMS reminder sent 3 days before (25th) every single month |

---

## 🔧 Production Checklist

Before going live, complete every item:

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Set real `DB_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY` (minimum 64 chars each)
- [ ] Enable `DB_SSL=true` and configure your cloud DB SSL certificate
- [ ] Set `FRONTEND_URL` to your real domain (e.g. `https://fasterloans.co.ug`)
- [ ] Switch Africa's Talking `AT_USERNAME` from `sandbox` to your live username
- [ ] Switch `PESAPAL_ENV=live` with live credentials
- [ ] Switch `FLW_ENV=live` with live Flutterwave keys
- [ ] Set `PESAPAL_IPN_URL` to your live server URL
- [ ] Configure Gmail App Password or production SMTP relay
- [ ] Place server behind HTTPS (Nginx + Let's Encrypt / Cloudflare)
- [ ] Set up automated daily MySQL backups (cron + mysqldump or AWS RDS snapshots)
- [ ] Configure log rotation (Winston `maxFiles` + OS logrotate)
- [ ] Restrict MySQL user to only the `faster_loans` database with minimum privileges
- [ ] Remove or protect `/api/admin` routes behind VPN or IP whitelist
- [ ] Register Pesapal IPN URL: `node -e "require('./services/paymentService').registerPesapalIPN()"`
- [ ] Test a full loan cycle end-to-end in staging before going live

---

## 📦 Install & Run Summary

```bash
# 1. Enter backend folder
cd "Faster loans/backend"

# 2. Install dependencies
npm install

# 3. Create .env from template
Copy-Item .env.example .env
# Edit .env with your values

# 4. Run database migration
node db/migrate.js

# 5. Start development server
npm run dev

# 6. Start production server
npm start
```

---

*Built for Faster Loans Uganda Limited — Kampala, Uganda 🇺🇬*  
*All timestamps use Africa/Kampala (EAT UTC+3)*
