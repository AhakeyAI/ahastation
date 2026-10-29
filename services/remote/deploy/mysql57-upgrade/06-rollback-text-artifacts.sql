-- DATA-PRESERVING rollback verification only. No DROP/DELETE/TRUNCATE/credential update.
-- First enter maintenance mode and reconcile original executions with matching .6 Station.
-- Keep new tables/backups and full local bytes. Roll back app only after disabling new artifact writes.
-- .5 clients cannot read .6 manifest accounts; do not replay execution with an older client.
-- Restoring old application binaries does not restore an old schema snapshot over current business rows.
USE station_hub;
SELECT version FROM hub_schema WHERE id=1;
SELECT COUNT(*) AS retained_manifests FROM collab_text_artifacts;
SELECT COUNT(*) AS retained_chunks FROM collab_text_chunks;
