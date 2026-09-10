-- Removes model search: the FTS5 index, its triggers, and the column they indexed.
--
-- Nothing read it. `GET /api/models?search=` was the only consumer and the app never called it —
-- model lists arrive whole through `/api/models/summary` and the browser filters them locally. The
-- three triggers meanwhile wrote to four shadow tables on every models row inserted, updated or
-- deleted, and a catalog refresh writes thousands.
--
-- Order matters: `models_fts_update` fires `AFTER UPDATE OF search_name`, and SQLite refuses to drop
-- a column a trigger references. The virtual table takes its shadow tables with it.
--
-- Drizzle models neither virtual tables nor triggers, so the first four statements are hand-written
-- and nothing would fail if they drifted. Only the last one is generated.
DROP TRIGGER IF EXISTS models_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS models_fts_delete;--> statement-breakpoint
DROP TRIGGER IF EXISTS models_fts_update;--> statement-breakpoint
DROP TABLE IF EXISTS models_fts;--> statement-breakpoint
ALTER TABLE `models` DROP COLUMN `search_name`;
