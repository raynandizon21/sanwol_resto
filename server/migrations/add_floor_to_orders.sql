-- Adds FLOOR ('gf'/'2f'/NULL) to orders: the floor an order belongs to, stamped
-- at creation by OrderModel.create (the table's own FLOOR if set, otherwise the
-- creating account's user_info.FLOOR). Lets floor-scoped waiter/cashier tablets
-- filter orders that have no table (takeout) or sit on a table with no FLOOR.
--
-- You normally don't need to run this by hand: the server adds the column on
-- boot (utils/ensureSchema.js -> ensureOrdersFloorColumn). It is kept here so
-- the schema change is on record and can be applied manually if the DB user
-- lacks ALTER privileges. Skip if the column already exists:
--   ALTER TABLE orders ADD COLUMN IF NOT EXISTS FLOOR VARCHAR(10) NULL DEFAULT NULL AFTER TABLE_ID;

ALTER TABLE orders
	ADD COLUMN FLOOR VARCHAR(10) NULL DEFAULT NULL AFTER TABLE_ID;
