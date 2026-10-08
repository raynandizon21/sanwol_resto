-- Adds an explicit per-table FLOOR ('gf'/'2f'/NULL), settable from the admin
-- Table Settings page. Only branches listed in FLOOR_ENABLED_BRANCH_IDS
-- (src/utils/floorScope.ts) are multi-floor; every other branch leaves this column NULL.
-- Safe to run once; skip if FLOOR already exists (MySQL 8.0.12+):
--   ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS FLOOR VARCHAR(10) NULL DEFAULT NULL AFTER TABLE_NUMBER;

ALTER TABLE restaurant_tables
	ADD COLUMN FLOOR VARCHAR(10) NULL DEFAULT NULL AFTER TABLE_NUMBER;
