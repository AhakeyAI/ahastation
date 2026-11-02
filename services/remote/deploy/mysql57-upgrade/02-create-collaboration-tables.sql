-- Existing station_hub schema 1 only. Back up first and stop incoming work.
-- In Navicat, disable "continue on error". Do not run schema-v2.sql on an old DB.
-- Requires InnoDB and DYNAMIC support. Inspect actual cloud settings first.
-- DDL is not transactionally reversible in MySQL 5.7.
-- This file adds four tables only. It does not change hub_schema or old data.
USE station_hub;

CREATE TABLE IF NOT EXISTS collab_accounts (
  owner VARCHAR(36) NOT NULL,
  `cursor` INTEGER NOT NULL,
  PRIMARY KEY (owner)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS collab_entities (
  owner VARCHAR(36) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  id VARCHAR(160) NOT NULL,
  revision INTEGER NOT NULL,
  data LONGTEXT NOT NULL,
  PRIMARY KEY (owner, kind, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS collab_events (
  owner VARCHAR(36) NOT NULL,
  seq INTEGER NOT NULL,
  data LONGTEXT NOT NULL,
  PRIMARY KEY (owner, seq)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS collab_requests (
  owner VARCHAR(36) NOT NULL,
  id VARCHAR(80) NOT NULL,
  digest VARCHAR(64) NOT NULL,
  result LONGTEXT NOT NULL,
  PRIMARY KEY (owner, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

SELECT TABLE_NAME, ENGINE, ROW_FORMAT, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA='station_hub'
  AND TABLE_NAME IN ('collab_accounts','collab_entities','collab_events','collab_requests')
ORDER BY TABLE_NAME;
