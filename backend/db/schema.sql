-- =============================================================
--  FASTER LOANS UGANDA  —  DATABASE SCHEMA
--  MySQL 8.0+ | Timezone: Africa/Kampala (EAT = UTC+3)
--  All DATETIME columns stored in EAT; server SET time_zone = '+03:00'
-- =============================================================

SET time_zone = '+03:00';   -- Uganda EAT throughout this session

CREATE DATABASE IF NOT EXISTS faster_loans
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE faster_loans;

-- Helper: every NOW() call returns Uganda time ---

-- -----------------------------------------------------------
-- 1. USERS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)        NOT NULL UNIQUE,
  role            ENUM('customer','officer','admin','superadmin') NOT NULL DEFAULT 'customer',
  first_name      VARCHAR(80)     NOT NULL,
  last_name       VARCHAR(80)     NOT NULL,
  email           VARCHAR(180)    NOT NULL UNIQUE,
  phone           VARCHAR(20)     NOT NULL UNIQUE,
  password_hash   VARCHAR(255)    NOT NULL,
  national_id     VARCHAR(30)     UNIQUE,
  date_of_birth   DATE,
  gender          ENUM('male','female','other'),
  district        VARCHAR(80),
  address         TEXT,
  is_verified     TINYINT(1)  NOT NULL DEFAULT 0,
  is_active       TINYINT(1)  NOT NULL DEFAULT 1,
  failed_logins   TINYINT     NOT NULL DEFAULT 0,
  locked_until    DATETIME,
  last_login      DATETIME,
  created_at      DATETIME    NOT NULL DEFAULT (CONVERT_TZ(NOW(), '+00:00', '+03:00')),
  updated_at      DATETIME    NOT NULL DEFAULT (CONVERT_TZ(NOW(), '+00:00', '+03:00'))
                              ON UPDATE (CONVERT_TZ(NOW(), '+00:00', '+03:00')),
  INDEX idx_email (email),
  INDEX idx_phone (phone),
  INDEX idx_role  (role)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 2. KYC DOCUMENTS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS kyc_documents (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      INT UNSIGNED NOT NULL,
  doc_type     ENUM('nid_front','nid_back','passport_photo',
                    'bank_statement','business_cert',
                    'collateral_doc','other') NOT NULL,
  file_path    VARCHAR(500) NOT NULL,
  file_hash    VARCHAR(64),
  verified     TINYINT(1)  NOT NULL DEFAULT 0,
  verified_by  INT UNSIGNED,
  verified_at  DATETIME,
  created_at   DATETIME    NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_kyc (user_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 3. NEXT OF KIN
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS next_of_kin (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id      INT UNSIGNED NOT NULL UNIQUE,
  full_name    VARCHAR(160) NOT NULL,
  relationship VARCHAR(60)  NOT NULL,
  phone        VARCHAR(20)  NOT NULL,
  address      TEXT,
  created_at   DATETIME     NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 4. LOAN PRODUCTS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_products (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code                VARCHAR(30)   NOT NULL UNIQUE,
  name                VARCHAR(100)  NOT NULL,
  min_amount          DECIMAL(14,2) NOT NULL,
  max_amount          DECIMAL(14,2) NOT NULL,
  monthly_rate        DECIMAL(6,4)  NOT NULL,
  min_tenure          TINYINT       NOT NULL,
  max_tenure          TINYINT       NOT NULL,
  requires_collateral TINYINT(1)    NOT NULL DEFAULT 0,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  created_at          DATETIME      NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00'))
) ENGINE=InnoDB;

INSERT IGNORE INTO loan_products
  (code,name,min_amount,max_amount,monthly_rate,min_tenure,max_tenure,requires_collateral)
VALUES
  ('personal',  'Personal Loan',           250000,  5000000, 0.0350, 1, 12, 0),
  ('business',  'Business Loan',          1000000, 30000000, 0.0300, 1, 36, 1),
  ('emergency', 'Emergency Loan',          250000,  2000000, 0.0400, 1,  6, 0),
  ('education', 'Education Loan',          500000, 10000000, 0.0300, 1, 24, 0),
  ('logbook',   'Logbook / Vehicle Loan', 1000000, 20000000, 0.0350, 1, 24, 1),
  ('mortgage',  'Asset / Mortgage Loan',  5000000, 30000000, 0.0200, 6, 48, 1);

-- -----------------------------------------------------------
-- 5. LOAN APPLICATIONS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_applications (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reference         VARCHAR(20)   NOT NULL UNIQUE,
  user_id           INT UNSIGNED  NOT NULL,
  product_id        INT UNSIGNED  NOT NULL,
  amount_requested  DECIMAL(14,2) NOT NULL,
  tenure_months     TINYINT       NOT NULL,
  purpose           VARCHAR(120),
  employment_status VARCHAR(40),
  employer_name     VARCHAR(120),
  monthly_income    VARCHAR(60),
  guarantor         TINYINT(1)    NOT NULL DEFAULT 0,
  collateral_type   VARCHAR(60),
  status            ENUM('pending','under_review','approved',
                         'rejected','disbursed','closed','defaulted')
                    NOT NULL DEFAULT 'pending',
  officer_id        INT UNSIGNED,
  rejection_reason  TEXT,
  applied_at        DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  reviewed_at       DATETIME,
  approved_at       DATETIME,
  disbursed_at      DATETIME,
  closed_at         DATETIME,
  FOREIGN KEY (user_id)    REFERENCES users(id),
  FOREIGN KEY (product_id) REFERENCES loan_products(id),
  FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ref      (reference),
  INDEX idx_user_app (user_id),
  INDEX idx_status   (status)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 6. APPROVED LOANS (live ledger)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  application_id          INT UNSIGNED  NOT NULL UNIQUE,
  user_id                 INT UNSIGNED  NOT NULL,
  product_id              INT UNSIGNED  NOT NULL,
  principal               DECIMAL(14,2) NOT NULL,
  monthly_rate            DECIMAL(6,4)  NOT NULL,
  tenure_months           TINYINT       NOT NULL,
  monthly_installment     DECIMAL(14,2) NOT NULL,
  total_repayable         DECIMAL(14,2) NOT NULL,
  outstanding_balance     DECIMAL(14,2) NOT NULL,
  amount_paid             DECIMAL(14,2) NOT NULL DEFAULT 0,
  deduction_day           TINYINT       NOT NULL DEFAULT 28,
  next_due_date           DATE          NOT NULL,
  installments_paid       TINYINT       NOT NULL DEFAULT 0,
  installments_remaining  TINYINT       NOT NULL,
  status                  ENUM('active','completed','defaulted','written_off')
                          NOT NULL DEFAULT 'active',
  disbursed_at            DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  completed_at            DATETIME,
  FOREIGN KEY (application_id) REFERENCES loan_applications(id),
  FOREIGN KEY (user_id)        REFERENCES users(id),
  FOREIGN KEY (product_id)     REFERENCES loan_products(id),
  INDEX idx_user_loan   (user_id),
  INDEX idx_loan_status (status),
  INDEX idx_due_date    (next_due_date)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 7. REPAYMENT SCHEDULE (28th every month)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS repayment_schedule (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loan_id         INT UNSIGNED  NOT NULL,
  installment_no  TINYINT       NOT NULL,
  due_date        DATE          NOT NULL,   -- always 28th of the month
  reminder_date   DATE          NOT NULL,   -- always 25th (3 days before)
  principal_due   DECIMAL(14,2) NOT NULL,
  interest_due    DECIMAL(14,2) NOT NULL,
  total_due       DECIMAL(14,2) NOT NULL,
  balance_after   DECIMAL(14,2) NOT NULL,
  status          ENUM('pending','paid','partial','overdue','waived')
                  NOT NULL DEFAULT 'pending',
  paid_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  paid_at         DATETIME,
  reminder_sent   TINYINT(1)    NOT NULL DEFAULT 0,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  UNIQUE KEY uq_loan_inst  (loan_id, installment_no),
  INDEX idx_due_sched      (due_date),
  INDEX idx_reminder_sched (reminder_date),
  INDEX idx_status_sched   (status)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 8. CARD MANDATES
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_mandates (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id             INT UNSIGNED NOT NULL,
  loan_id             INT UNSIGNED,
  provider_mandate_id VARCHAR(120),
  card_last_four      CHAR(4)      NOT NULL,
  card_brand          VARCHAR(20),
  card_holder         VARCHAR(120),
  card_expiry         CHAR(5),
  card_token          VARCHAR(500) NOT NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  authorised_at       DATETIME     NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  consent_ip          VARCHAR(45),
  consent_user_agent  TEXT,
  revoked_at          DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL,
  INDEX idx_user_mandate (user_id),
  INDEX idx_loan_mandate (loan_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 9. TRANSACTIONS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)      NOT NULL UNIQUE,
  loan_id         INT UNSIGNED,
  schedule_id     INT UNSIGNED,
  user_id         INT UNSIGNED  NOT NULL,
  type            ENUM('disbursement','repayment','penalty',
                       'refund','waiver') NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  currency        CHAR(3)       NOT NULL DEFAULT 'UGX',
  method          ENUM('auto_debit','bank_transfer','cash',
                       'card','adjustment') NOT NULL,
  provider        VARCHAR(60),
  provider_ref    VARCHAR(120),
  status          ENUM('pending','success','failed','reversed')
                  NOT NULL DEFAULT 'pending',
  failure_reason  TEXT,
  processed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (loan_id)     REFERENCES loans(id) ON DELETE SET NULL,
  FOREIGN KEY (schedule_id) REFERENCES repayment_schedule(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id)     REFERENCES users(id),
  INDEX idx_txn_loan   (loan_id),
  INDEX idx_txn_user   (user_id),
  INDEX idx_txn_status (status),
  INDEX idx_txn_date   (created_at)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 10. BANK ACCOUNTS (for disbursement)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id             INT UNSIGNED  NOT NULL UNIQUE,
  bank_name           VARCHAR(100)  NOT NULL,
  account_name        VARCHAR(160)  NOT NULL,
  account_number_enc  VARCHAR(500)  NOT NULL,
  branch              VARCHAR(100),
  verified            TINYINT(1)    NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 11. NOTIFICATIONS LOG
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  channel    ENUM('sms','email','push') NOT NULL,
  type       VARCHAR(60)  NOT NULL,
  recipient  VARCHAR(180) NOT NULL,
  subject    VARCHAR(200),
  body       TEXT         NOT NULL,
  status     ENUM('sent','failed','pending') NOT NULL DEFAULT 'pending',
  sent_at    DATETIME,
  error_msg  TEXT,
  created_at DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id),
  INDEX idx_notif_type (type)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 12. AUDIT LOG (append-only)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    INT UNSIGNED,
  actor_role  VARCHAR(20),
  action      VARCHAR(100) NOT NULL,
  entity      VARCHAR(60),
  entity_id   VARCHAR(40),
  old_values  JSON,
  new_values  JSON,
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  created_at  DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  INDEX idx_audit_actor  (actor_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_entity (entity, entity_id),
  INDEX idx_audit_date   (created_at)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 13. CONSENT RECORDS (PDPA Uganda 2019)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_records (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  consent_type  ENUM('data_processing','marketing','auto_debit_mandate',
                     'credit_check','terms') NOT NULL,
  granted       TINYINT(1)   NOT NULL,
  version       VARCHAR(10)  NOT NULL DEFAULT '1.0',
  ip_address    VARCHAR(45),
  user_agent    TEXT,
  granted_at    DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  revoked_at    DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_consent_user (user_id),
  INDEX idx_consent_type (consent_type)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 14. OTP TOKENS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_tokens (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  VARCHAR(64)  NOT NULL,
  purpose     ENUM('verify_phone','verify_email','reset_password','login_2fa') NOT NULL,
  expires_at  DATETIME     NOT NULL,
  used        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_otp_user (user_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------------
-- 15. REFRESH TOKENS
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  VARCHAR(64)  NOT NULL UNIQUE,
  expires_at  DATETIME     NOT NULL,
  revoked     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT (CONVERT_TZ(NOW(),'+00:00','+03:00')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rt_user (user_id)
) ENGINE=InnoDB;
