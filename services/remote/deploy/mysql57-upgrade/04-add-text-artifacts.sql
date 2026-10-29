-- Run after backup, on station_hub schema2, with an operator DDL account.
-- Runtime credentials keep DML only. No existing table, account or row is replaced.
USE station_hub;
SET @text_schema_ok := (SELECT version=2 FROM hub_schema WHERE id=1);
SET @text_ddl := IF(@text_schema_ok, 'CREATE TABLE IF NOT EXISTS collab_text_artifacts (owner varchar(36) NOT NULL, id varchar(36) NOT NULL, task_id varchar(36) NOT NULL, attempt_id varchar(36) NOT NULL, device_id varchar(36) NOT NULL, byte_length int NOT NULL, data LONGTEXT NOT NULL, PRIMARY KEY(owner,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC', 'SELECT ''BLOCKED: schema2 required; no DDL applied'' AS migration_status');
PREPARE text_migration FROM @text_ddl;
EXECUTE text_migration;
DEALLOCATE PREPARE text_migration;
SET @text_ddl := IF(@text_schema_ok, 'CREATE TABLE IF NOT EXISTS collab_text_chunks (owner varchar(36) NOT NULL, artifact_id varchar(36) NOT NULL, part int NOT NULL, sha256 varchar(64) NOT NULL, data BLOB NOT NULL, PRIMARY KEY(owner,artifact_id,part)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC', 'SELECT ''BLOCKED: schema2 required; no DDL applied'' AS migration_status');
PREPARE text_migration FROM @text_ddl;
EXECUTE text_migration;
DEALLOCATE PREPARE text_migration;
