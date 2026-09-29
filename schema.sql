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

CREATE TABLE IF NOT EXISTS tm_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES tm_users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tm_withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES tm_users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  account_number VARCHAR(40) NOT NULL,
  account_name VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tm_transactions_user ON tm_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tm_withdrawals_user ON tm_withdrawals(user_id);
