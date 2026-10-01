-- =========================================================
-- TASKMINT DATABASE SCHEMA
-- =========================================================

-- =========================================================
-- USERS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_earned NUMERIC(12,2) NOT NULL DEFAULT 0,
  referral_code VARCHAR(32) UNIQUE NOT NULL,
  referred_by INTEGER REFERENCES tm_users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================================================
-- TRANSACTIONS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL
    REFERENCES tm_users(id)
    ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================================================
-- WITHDRAWALS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL
    REFERENCES tm_users(id)
    ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  account_number VARCHAR(40) NOT NULL,
  account_name VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);


-- =========================================================
-- TASKS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  description TEXT,
  reward NUMERIC(12,2) NOT NULL DEFAULT 0,
  task_type VARCHAR(40) NOT NULL DEFAULT 'ad',
  provider VARCHAR(80) NOT NULL DEFAULT 'internal',
  provider_task_id VARCHAR(255),
  icon VARCHAR(20) NOT NULL DEFAULT '🎯',
  daily_limit INTEGER,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================================================
-- TASK COMPLETIONS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_task_completions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL
    REFERENCES tm_users(id)
    ON DELETE CASCADE,

  task_id INTEGER NOT NULL
    REFERENCES tm_tasks(id)
    ON DELETE CASCADE,

  reward NUMERIC(12,2) NOT NULL,

  provider_reference VARCHAR(255),

  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  started_at TIMESTAMP,

  completed_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================================================
-- DAILY CLAIMS
-- =========================================================

CREATE TABLE IF NOT EXISTS tm_daily_claims (
  id SERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL
    REFERENCES tm_users(id)
    ON DELETE CASCADE,

  claim_date DATE NOT NULL,

  reward NUMERIC(12,2) NOT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, claim_date)
);


-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_tm_transactions_user
ON tm_transactions(user_id);


CREATE INDEX IF NOT EXISTS idx_tm_withdrawals_user
ON tm_withdrawals(user_id);


CREATE INDEX IF NOT EXISTS idx_tm_task_completions_user
ON tm_task_completions(user_id);


CREATE INDEX IF NOT EXISTS idx_tm_task_completions_task
ON tm_task_completions(task_id);


CREATE INDEX IF NOT EXISTS idx_tm_tasks_active
ON tm_tasks(active);


CREATE INDEX IF NOT EXISTS idx_tm_daily_claims_user
ON tm_daily_claims(user_id);


-- =========================================================
-- IMPORTANT
-- =========================================================
-- Default tasks are NOT inserted here.
-- They are created safely by server.js AFTER migration.
-- =========================================================
