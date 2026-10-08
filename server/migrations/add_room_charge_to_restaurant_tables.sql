-- Adds per-table room/service charge used by tableModel and Orders UI.
-- Safe to run once; skip if ROOM_CHARGE already exists (MySQL 8.0.12+):
--   ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS ROOM_CHARGE DECIMAL(12,2) NULL DEFAULT NULL AFTER CAPACITY;

ALTER TABLE restaurant_tables
	ADD COLUMN ROOM_CHARGE DECIMAL(12,2) NULL DEFAULT NULL AFTER CAPACITY;
