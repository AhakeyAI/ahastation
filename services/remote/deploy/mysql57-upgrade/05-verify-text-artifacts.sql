-- Read-only verification. Both tables and all columns/indexes must match before .6 starts.
USE station_hub;
SELECT version AS existing_schema_version FROM hub_schema WHERE id=1;
SELECT TABLE_NAME,ENGINE,ROW_FORMAT,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('collab_text_artifacts','collab_text_chunks');
SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('collab_text_artifacts','collab_text_chunks') ORDER BY TABLE_NAME,ORDINAL_POSITION;
SELECT TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('collab_text_artifacts','collab_text_chunks') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX;
SELECT COUNT(*) AS preserved_text_manifests,COALESCE(SUM(byte_length),0) AS retained_text_bytes FROM collab_text_artifacts;
SELECT COUNT(*) AS preserved_text_chunks FROM collab_text_chunks;
