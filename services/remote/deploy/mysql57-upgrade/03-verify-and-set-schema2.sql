-- Run separately, only after file 02 completed WITHOUT errors.
-- Does not promote unknown schema versions or missing/incompatible tables.
USE station_hub;
SET @collab_tables_ok := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA='station_hub'
    AND TABLE_NAME IN ('collab_accounts','collab_entities','collab_events','collab_requests')
    AND ENGINE='InnoDB' AND ROW_FORMAT='Dynamic' AND TABLE_COLLATION='utf8mb4_bin'
);
SET @collab_columns_ok := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA='station_hub' AND IS_NULLABLE='NO' AND (
    (TABLE_NAME='collab_accounts' AND
      ((COLUMN_NAME='owner' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=36) OR
       (COLUMN_NAME='cursor' AND DATA_TYPE='int'))) OR
    (TABLE_NAME='collab_entities' AND
      ((COLUMN_NAME='owner' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=36) OR
       (COLUMN_NAME='kind' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=24) OR
       (COLUMN_NAME='id' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=160) OR
       (COLUMN_NAME='revision' AND DATA_TYPE='int') OR
       (COLUMN_NAME='data' AND DATA_TYPE='longtext'))) OR
    (TABLE_NAME='collab_events' AND
      ((COLUMN_NAME='owner' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=36) OR
       (COLUMN_NAME='seq' AND DATA_TYPE='int') OR
       (COLUMN_NAME='data' AND DATA_TYPE='longtext'))) OR
    (TABLE_NAME='collab_requests' AND
      ((COLUMN_NAME='owner' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=36) OR
       (COLUMN_NAME='id' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=80) OR
       (COLUMN_NAME='digest' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=64) OR
       (COLUMN_NAME='result' AND DATA_TYPE='longtext')))
  )
);
SET @collab_primary_keys_ok := (
  SELECT COUNT(*) FROM (
    SELECT TABLE_NAME,
           GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS key_columns,
           SUM(SUB_PART IS NOT NULL) AS prefix_columns
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA='station_hub' AND INDEX_NAME='PRIMARY'
      AND TABLE_NAME IN ('collab_accounts','collab_entities','collab_events','collab_requests')
    GROUP BY TABLE_NAME
  ) AS pk
  WHERE prefix_columns=0 AND (
    (TABLE_NAME='collab_accounts' AND key_columns='owner') OR
    (TABLE_NAME='collab_entities' AND key_columns='owner,kind,id') OR
    (TABLE_NAME='collab_events' AND key_columns='owner,seq') OR
    (TABLE_NAME='collab_requests' AND key_columns='owner,id')
  )
);
UPDATE hub_schema
SET version=2
WHERE id=1 AND version=1
  AND @collab_tables_ok=4 AND @collab_columns_ok=14 AND @collab_primary_keys_ok=4;
SELECT @collab_tables_ok AS compatible_tables_must_be_4,
       @collab_columns_ok AS compatible_columns_must_be_14,
       @collab_primary_keys_ok AS compatible_primary_keys_must_be_4;
SELECT id, version FROM hub_schema WHERE id=1;
