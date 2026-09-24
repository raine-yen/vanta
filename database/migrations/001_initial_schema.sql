-- Vanta MySQL 8 schema. IDs are supplied by the application (or UUID() in seeds).
-- Historical PostgreSQL files in supabase/ are never run against this database.
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  role ENUM('member','manager','owner') NOT NULL DEFAULT 'member',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  refresh_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  refresh_expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sessions_user (user_id, revoked_at),
  KEY idx_sessions_expiry (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS competitions (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  starting_cash DECIMAL(20,6) NOT NULL DEFAULT 10000,
  start_date DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  end_date DATETIME(3),
  status ENUM('draft','open','active','locked','settled','ended') NOT NULL DEFAULT 'active',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by CHAR(36),
  scoring_method ENUM('return_pct','net_profit') NOT NULL DEFAULT 'return_pct',
  max_entrants INT,
  allow_crypto BOOLEAN NOT NULL DEFAULT TRUE,
  prize_description TEXT,
  rules TEXT,
  published_at DATETIME(3),
  locked_at DATETIME(3),
  settled_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_competitions_discovery (status, start_date, created_at),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS accounts (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  competition_id CHAR(36) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  cash DECIMAL(20,6) NOT NULL DEFAULT 10000,
  starting_cash DECIMAL(20,6) NOT NULL DEFAULT 10000,
  equity DECIMAL(20,6) NOT NULL DEFAULT 10000,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  suspended_until DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_accounts_user_competition (user_id, competition_id),
  KEY idx_accounts_competition (competition_id, status, equity),
  KEY idx_accounts_suspended (suspended_until),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_keys (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  key_id VARCHAR(100) NOT NULL UNIQUE,
  secret_hash VARCHAR(255) NOT NULL,
  label VARCHAR(80),
  last_used_at DATETIME(3),
  revoked_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_api_keys_user (user_id, created_at),
  KEY idx_api_keys_account (account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS positions (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  qty DECIMAL(20,8) NOT NULL DEFAULT 0,
  avg_entry_price DECIMAL(20,8) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_positions_account_symbol (account_id, symbol),
  KEY idx_positions_symbol (symbol),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  client_order_id VARCHAR(128),
  symbol VARCHAR(32) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  type ENUM('market','limit') NOT NULL DEFAULT 'market',
  qty DECIMAL(20,8) NOT NULL DEFAULT 0,
  limit_price DECIMAL(20,8),
  status ENUM('new','filled','partially_filled','canceled','rejected','expired') NOT NULL DEFAULT 'new',
  filled_qty DECIMAL(20,8) NOT NULL DEFAULT 0,
  filled_avg_price DECIMAL(20,8),
  reject_reason TEXT,
  time_in_force ENUM('gtc','day','ioc') NOT NULL DEFAULT 'gtc',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  filled_at DATETIME(3), canceled_at DATETIME(3), scheduled_at DATETIME(3),
  UNIQUE KEY uq_orders_client (account_id, client_order_id),
  KEY idx_orders_account_created (account_id, created_at),
  KEY idx_orders_status_scheduled (status, scheduled_at),
  KEY idx_orders_symbol (symbol),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fills (
  id CHAR(36) PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  qty DECIMAL(20,8) NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_fills_account_created (account_id, created_at),
  KEY idx_fills_order (order_id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ledger (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  order_id CHAR(36),
  symbol VARCHAR(32) NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  qty DECIMAL(20,8) NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  total DECIMAL(20,6) NOT NULL,
  cash_after DECIMAL(20,6) NOT NULL,
  commission DECIMAL(20,6) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ledger_account_created (account_id, created_at),
  KEY idx_ledger_order (order_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  equity DECIMAL(20,6) NOT NULL,
  cash DECIMAL(20,6) NOT NULL DEFAULT 0,
  positions_value DECIMAL(20,6) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_equity_snapshots_account_created (account_id, created_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assets (
  id CHAR(36) PRIMARY KEY,
  symbol VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  sector VARCHAR(255), industry VARCHAR(255),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quotes (
  id CHAR(36) PRIMARY KEY,
  symbol VARCHAR(32) NOT NULL UNIQUE,
  price DECIMAL(20,8) NOT NULL DEFAULT 0,
  bid DECIMAL(20,8) NOT NULL DEFAULT 0,
  ask DECIMAL(20,8) NOT NULL DEFAULT 0,
  timestamp DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prices (
  symbol VARCHAR(32) PRIMARY KEY,
  price DECIMAL(20,8) NOT NULL DEFAULT 0,
  prev_close DECIMAL(20,8),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_prices_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS watchlists (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  note TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_watchlists_account_symbol (account_id, symbol),
  KEY idx_watchlists_account_created (account_id, created_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_alerts (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  direction ENUM('above','below','move') NOT NULL,
  target_price DECIMAL(20,8),
  move_pct DECIMAL(12,6),
  status ENUM('active','paused','triggered','deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_alerts_account_status (account_id, status, created_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trader_profiles (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  strategy TEXT,
  risk_style ENUM('conservative','balanced','aggressive') NOT NULL DEFAULT 'balanced',
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS seasons (
  id CHAR(36) PRIMARY KEY,
  club_id CHAR(36),
  competition_id CHAR(36),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  starts_at DATETIME(3),
  start_date DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  end_date DATETIME(3),
  status ENUM('active','ended') NOT NULL DEFAULT 'active',
  rank_thresholds JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_seasons_status (status, start_date),
  KEY idx_seasons_competition (competition_id, status, starts_at),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ranks (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  season_id CHAR(36),
  tier INT NOT NULL DEFAULT 1,
  division INT NOT NULL DEFAULT 1,
  rank_points DECIMAL(20,6) NOT NULL DEFAULT 0,
  position_in_tier INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ranks_account_season (account_id, season_id),
  KEY idx_ranks_season (season_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leader_history (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  season_id CHAR(36),
  position INT NOT NULL,
  tier INT NOT NULL DEFAULT 1,
  division INT NOT NULL DEFAULT 1,
  rank_points DECIMAL(20,6) NOT NULL DEFAULT 0,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_leader_history_account_time (account_id, recorded_at),
  KEY idx_leader_history_season_position (season_id, position),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Internal IDs are CHAR(36); the upstream Polymarket condition key is separate.
CREATE TABLE IF NOT EXISTS prediction_markets (
  id CHAR(36) PRIMARY KEY,
  condition_id VARCHAR(255) NOT NULL UNIQUE,
  question TEXT NOT NULL,
  category VARCHAR(100),
  yes_token_id VARCHAR(255), no_token_id VARCHAR(255),
  yes_price DECIMAL(12,8), no_price DECIMAL(12,8),
  volume_24h DECIMAL(22,6),
  end_date DATETIME(3),
  status ENUM('active','closed','resolved') NOT NULL DEFAULT 'active',
  resolved_outcome ENUM('yes','no'),
  settled_at DATETIME(3),
  image TEXT, url TEXT,
  event_slug VARCHAR(255), tags JSON,
  yes_label VARCHAR(255), no_label VARCHAR(255),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_prediction_markets_status_volume (status, volume_24h),
  KEY idx_prediction_markets_event (event_slug),
  KEY idx_prediction_markets_end (end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prediction_positions (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  market_id CHAR(36) NOT NULL,
  outcome ENUM('yes','no') NOT NULL,
  shares DECIMAL(20,8) NOT NULL DEFAULT 0,
  avg_cost DECIMAL(12,8) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_prediction_position (account_id, market_id, outcome),
  KEY idx_prediction_positions_market (market_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (market_id) REFERENCES prediction_markets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prediction_fills (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  market_id CHAR(36) NOT NULL,
  outcome ENUM('yes','no') NOT NULL,
  side ENUM('buy','sell','settle') NOT NULL,
  shares DECIMAL(20,8) NOT NULL,
  price DECIMAL(12,8) NOT NULL,
  total DECIMAL(20,6) NOT NULL,
  cash_after DECIMAL(20,6) NOT NULL,
  client_order_id VARCHAR(128),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_prediction_fill_client (account_id, client_order_id),
  KEY idx_prediction_fills_account_created (account_id, created_at),
  KEY idx_prediction_fills_market (market_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (market_id) REFERENCES prediction_markets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS blocked_users (
  id CHAR(36) PRIMARY KEY,
  blocker_account_id CHAR(36) NOT NULL,
  blocked_account_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_blocked_users (blocker_account_id, blocked_account_id),
  KEY idx_blocked_users_target (blocked_account_id),
  FOREIGN KEY (blocker_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS direct_messages (
  id CHAR(36) PRIMARY KEY,
  sender_account_id CHAR(36) NOT NULL,
  recipient_account_id CHAR(36) NOT NULL,
  body VARCHAR(500) NOT NULL,
  hidden_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  read_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_messages_sender (sender_account_id, created_at),
  KEY idx_messages_recipient (recipient_account_id, created_at),
  FOREIGN KEY (sender_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS message_reports (
  id CHAR(36) PRIMARY KEY,
  message_id CHAR(36) NOT NULL,
  reporter_account_id CHAR(36) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('open','reviewed','dismissed') NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at DATETIME(3),
  UNIQUE KEY uq_message_reports (message_id, reporter_account_id),
  KEY idx_message_reports_status (status, created_at),
  FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quest_points (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  quest_id VARCHAR(100) NOT NULL,
  cycle_id VARCHAR(100) NOT NULL,
  points INT NOT NULL DEFAULT 200,
  claimed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_quest_points (account_id, quest_id, cycle_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO competitions (id, name, description, starting_cash, is_default, status)
SELECT UUID(), 'Club Sandbox', 'Always-on practice competition. Trade freely.', 10000, TRUE, 'active'
WHERE NOT EXISTS (SELECT 1 FROM competitions WHERE is_default = TRUE);

INSERT INTO seasons (id, competition_id, name, starts_at, status)
SELECT UUID(), c.id, 'Default Season', UTC_TIMESTAMP(3), 'active'
FROM competitions c
WHERE c.is_default = TRUE
  AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.competition_id = c.id AND s.status = 'active');
