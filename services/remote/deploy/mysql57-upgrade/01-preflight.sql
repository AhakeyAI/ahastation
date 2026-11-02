-- Read-only checks. Run in Navicat before any schema change.
SELECT VERSION() AS mysql_version, DATABASE() AS selected_database,
       CURRENT_USER() AS authenticated_database_account;
SELECT id, version FROM station_hub.hub_schema WHERE id = 1;
SHOW VARIABLES WHERE Variable_name IN
  ('innodb_default_row_format', 'innodb_large_prefix', 'innodb_file_format',
   'innodb_file_per_table', 'innodb_page_size', 'innodb_strict_mode');
SELECT TABLE_NAME, ENGINE, ROW_FORMAT, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'station_hub'
ORDER BY TABLE_NAME;
SELECT COUNT(*) AS existing_users FROM station_hub.hub_users;
SELECT COUNT(*) AS existing_devices FROM station_hub.hub_devices;
SELECT COUNT(*) AS existing_credentials FROM station_hub.hub_credentials;
SELECT COUNT(*) AS existing_tasks FROM station_hub.hub_tasks;
SHOW GRANTS;
