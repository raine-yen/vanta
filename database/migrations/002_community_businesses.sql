CREATE TABLE IF NOT EXISTS clubs (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  tier_requirements JSON,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS challenges (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  season_id CHAR(36),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  target DECIMAL(20,6) NOT NULL DEFAULT 0,
  current DECIMAL(20,6) NOT NULL DEFAULT 0,
  status ENUM('active','completed','failed') NOT NULL DEFAULT 'active',
  completed_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_challenges_account_status (account_id, status),
  KEY idx_challenges_season (season_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS achievements (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  icon VARCHAR(100),
  earned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_achievements_account_earned (account_id, earned_at),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS businesses (
  id CHAR(36) PRIMARY KEY,
  owner_user_id CHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,
  description TEXT,
  website_url TEXT,
  status ENUM('draft','active','suspended','closed') NOT NULL DEFAULT 'draft',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_businesses_owner_status (owner_user_id, status),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leaderboard (
  account_id CHAR(36) PRIMARY KEY,
  competition_id CHAR(36) NOT NULL,
  position INT NOT NULL,
  equity DECIMAL(20,6) NOT NULL,
  return_pct DECIMAL(14,6) NOT NULL,
  score DECIMAL(20,6) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_leaderboard_competition_position (competition_id, position),
  KEY idx_leaderboard_competition_score (competition_id, score),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
