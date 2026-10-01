-- =========================================================
-- TASKMINT DATABASE SCHEMA
-- Users / Transactions / Withdrawals / Tasks / Bonuses
-- =========================================================

-- =========================
-- USERS
-- =========================

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


-- =========================
-- TRANSACTIONS
-- =========================

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


-- =========================
-- WITHDRAWALS
-- =========================

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


-- =========================
-- TASKS / OFFERS
-- =========================

CREATE TABLE IF NOT EXISTS tm_tasks (
  id SERIAL PRIMARY KEY,

  title VARCHAR(120) NOT NULL,

  description TEXT,

  reward NUMERIC(12,2) NOT NULL DEFAULT 0,

  task_type VARCHAR(40) NOT NULL DEFAULT 'task',

  provider VARCHAR(50),

  provider_task_id VARCHAR(255),

  icon VARCHAR(20) DEFAULT '🎯',

  active BOOLEAN NOT NULL DEFAULT true,

  daily_limit INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================
-- TASK COMPLETIONS
-- =========================

CREATE TABLE IF NOT EXISTS tm_task_completions (
  id SERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL
    REFERENCES tm_users(id)
    ON DELETE CASCADE,

  task_id INTEGER NOT NULL
    REFERENCES tm_tasks(id)
    ON DELETE CASCADE,

  reward NUMERIC(12,2) NOT NULL,

  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  provider_reference VARCHAR(255),

  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  completed_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- =========================
-- DAILY BONUS CLAIMS
-- =========================

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


-- =========================
-- INDEXES
-- =========================

CREATE INDEX IF NOT EXISTS
idx_tm_transactions_user
ON tm_transactions(user_id);


CREATE INDEX IF NOT EXISTS
idx_tm_withdrawals_user
ON tm_withdrawals(user_id);


CREATE INDEX IF NOT EXISTS
idx_tm_task_completions_user
ON tm_task_completions(user_id);


CREATE INDEX IF NOT EXISTS
idx_tm_task_completions_task
ON tm_task_completions(task_id);


CREATE INDEX IF NOT EXISTS
idx_tm_tasks_active
ON tm_tasks(active);


CREATE INDEX IF NOT EXISTS
idx_tm_daily_claims_user
ON tm_daily_claims(user_id);


-- =========================================================
-- DEFAULT TASKS
-- =========================================================

INSERT INTO tm_tasks
(
  title,
  description,
  reward,
  task_type,
  provider,
  icon,
  active
)
SELECT
  'Watch & Earn',
  'Watch an eligible sponsored advertisement and receive the verified reward.',
  0.50,
  'ad',
  'internal',
  '🎬',
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM tm_tasks
  WHERE task_type = 'ad'
);


INSERT INTO tm_tasks
(
  title,
  description,
  reward,
  task_type,
  provider,
  icon,
  active
)
SELECT
  'Daily App Task',
  'Complete the available activity according to the task instructions.',
  1.00,
  'app',
  'internal',
  '📱',
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM tm_tasks
  WHERE task_type = 'app'
);


INSERT INTO tm_tasks
(
  title,
  description,
  reward,
  task_type,
  provider,
  icon,
  active
)
SELECT
  'Game Offer',
  'Complete the game offer requirements to receive the verified reward.',
  2.00,
  'game',
  'internal',
  '🎮',
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM tm_tasks
  WHERE task_type = 'game'
);


INSERT INTO tm_tasks
(
  title,
  description,
  reward,
  task_type,
  provider,
  icon,
  active
)
SELECT
  'Survey',
  'Complete an eligible survey and wait for verification.',
  1.50,
  'survey',
  'internal',
  '📝',
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM tm_tasks
  WHERE task_type = 'survey'
);
