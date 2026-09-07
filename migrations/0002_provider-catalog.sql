CREATE TABLE `model_catalog_refresh` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner` text,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`current_version` text,
	`previous_version` text,
	CONSTRAINT "model_catalog_refresh_singleton_check" CHECK("model_catalog_refresh"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `provider_interfaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`native_files` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_interfaces_protocol_check" CHECK("provider_interfaces"."protocol" IN ('responses', 'chat-completions', 'anthropic', 'vertex-compatible')),
	CONSTRAINT "provider_interfaces_native_files_check" CHECK("provider_interfaces"."protocol" != 'vertex-compatible' OR "provider_interfaces"."native_files" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_interfaces_provider_protocol_uq` ON `provider_interfaces` (`provider_id`,`protocol`);--> statement-breakpoint
DROP INDEX `attachment_provider_files_uq`;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `credential_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `file_family` text;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `base_url` text;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `cleanup_after` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `cleanup_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attachment_provider_files` ADD `last_cleanup_error` text;--> statement-breakpoint
CREATE INDEX `attachment_provider_files_reuse_idx` ON `attachment_provider_files` (`attachment_id`,`provider_id`,`credential_version`,`file_family`,`base_url`,`expires_at`);--> statement-breakpoint
CREATE INDEX `attachment_provider_files_cleanup_idx` ON `attachment_provider_files` (`cleanup_after`,`expires_at`);--> statement-breakpoint
ALTER TABLE `models` ADD `interface_id` integer REFERENCES provider_interfaces(id) ON DELETE NO ACTION;--> statement-breakpoint
ALTER TABLE `models` ADD `metadata_override` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `metadata_resolved` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `catalog_matches` text DEFAULT '{"operator":null,"lab":null,"global":null}' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `search_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `lab_id` text;--> statement-breakpoint
ALTER TABLE `models` ADD `supports_image_input` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `supports_reasoning` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `supports_tools` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `supports_image_output` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `context_limit` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `output_limit` integer;--> statement-breakpoint
CREATE INDEX `models_provider_enabled_sort_idx` ON `models` (`provider_id`,`enabled`,`sort`,`id`);--> statement-breakpoint
CREATE INDEX `models_enabled_image_idx` ON `models` (`enabled`,`supports_image_input`,`sort`,`id`);--> statement-breakpoint
CREATE INDEX `models_enabled_reasoning_idx` ON `models` (`enabled`,`supports_reasoning`,`sort`,`id`);--> statement-breakpoint
CREATE INDEX `models_enabled_tools_idx` ON `models` (`enabled`,`supports_tools`,`sort`,`id`);--> statement-breakpoint
CREATE INDEX `models_enabled_image_output_idx` ON `models` (`enabled`,`supports_image_output`,`sort`,`id`);--> statement-breakpoint
CREATE INDEX `models_enabled_context_idx` ON `models` (`enabled`,`context_limit`);--> statement-breakpoint
CREATE INDEX `models_interface_idx` ON `models` (`interface_id`);--> statement-breakpoint
CREATE INDEX `models_lab_enabled_sort_idx` ON `models` (`lab_id`,`enabled`,`sort`,`id`);--> statement-breakpoint
ALTER TABLE `providers` ADD `default_interface_id` integer REFERENCES provider_interfaces(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `credential_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `models_dev_provider_id` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `models_dev_provider_source` text;--> statement-breakpoint

-- Native Vertex credentials have different semantics. Preserve the row for explicit reconfiguration.
UPDATE providers SET enabled = 0 WHERE protocol = 'vertex';--> statement-breakpoint
INSERT INTO provider_interfaces (provider_id, protocol, base_url, native_files, created_at)
SELECT id, CASE protocol WHEN 'openai-responses' THEN 'responses' WHEN 'openai-completions' THEN 'chat-completions' ELSE protocol END,
       base_url, CASE WHEN protocol = 'vertex-compatible' THEN 0 ELSE native_files END, created_at
FROM providers WHERE protocol IN ('openai-responses', 'openai-completions', 'anthropic', 'vertex-compatible');--> statement-breakpoint
UPDATE providers SET default_interface_id = (SELECT id FROM provider_interfaces WHERE provider_id = providers.id);--> statement-breakpoint

-- Only exact known preset endpoints identify a catalog provider without a catalog snapshot.
UPDATE providers SET models_dev_provider_id = CASE rtrim(base_url, '/')
  WHEN 'https://api.openai.com/v1' THEN 'openai'
  WHEN 'https://api.anthropic.com/v1' THEN 'anthropic'
  WHEN 'https://api.deepseek.com/v1' THEN 'deepseek'
  WHEN 'https://openrouter.ai/api/v1' THEN 'openrouter'
END, models_dev_provider_source = 'endpoint'
WHERE protocol != 'vertex';--> statement-breakpoint
UPDATE providers SET models_dev_provider_source = 'manual'
WHERE (models_dev_provider_id = 'openai' AND name = 'OpenAI')
   OR (models_dev_provider_id = 'anthropic' AND name = 'Anthropic')
   OR (models_dev_provider_id = 'deepseek' AND name = 'DeepSeek')
   OR (models_dev_provider_id = 'openrouter' AND name = 'OpenRouter');--> statement-breakpoint

UPDATE models SET metadata_override = json_set(metadata_override, '$.name', display_name)
WHERE display_name != model_id;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.reasoning', json(CASE json_extract(capabilities, '$.reasoning') WHEN 1 THEN 'true' ELSE 'false' END))
WHERE json_type(capabilities, '$.reasoning') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.tool_call', json(CASE json_extract(capabilities, '$.tools') WHEN 1 THEN 'true' ELSE 'false' END))
WHERE json_type(capabilities, '$.tools') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.modalities.input', json(CASE json_extract(capabilities, '$.vision') WHEN 1 THEN '["text","image"]' ELSE '["text"]' END))
WHERE json_type(capabilities, '$.vision') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.modalities.output', json(CASE json_extract(capabilities, '$.image_output') WHEN 1 THEN '["text","image"]' ELSE '["text"]' END))
WHERE json_type(capabilities, '$.image_output') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.reasoning_options', json(CASE json_extract(capabilities, '$.reasoning_can_disable') WHEN 1 THEN '[{"type":"toggle"}]' ELSE '[]' END))
WHERE json_type(capabilities, '$.reasoning_can_disable') IS NOT NULL OR json_type(capabilities, '$.reasoning_efforts') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_insert(metadata_override, '$.reasoning_options[#]', json_object('type', 'effort', 'values', json_extract(capabilities, '$.reasoning_efforts')))
WHERE json_type(capabilities, '$.reasoning_efforts') = 'array';--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.cost', json('{}')) WHERE pricing IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.cost.input', json_extract(pricing, '$.input')) WHERE json_type(pricing, '$.input') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.cost.output', json_extract(pricing, '$.output')) WHERE json_type(pricing, '$.output') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_override = json_set(metadata_override, '$.cost.cache_read', json_extract(pricing, '$.cached')) WHERE json_type(pricing, '$.cached') IS NOT NULL;--> statement-breakpoint
UPDATE models SET metadata_resolved = CASE WHEN json_type(metadata_override, '$.modalities') IS NOT NULL
  THEN json_patch('{"modalities":{"input":["text"],"output":["text"]}}', metadata_override) ELSE metadata_override END,
  search_name = lower(display_name || ' ' || model_id),
  supports_image_input = coalesce(json_extract(capabilities, '$.vision'), 0),
  supports_image_output = coalesce(json_extract(capabilities, '$.image_output'), 0),
  supports_reasoning = coalesce(json_extract(capabilities, '$.reasoning'), 0),
  supports_tools = coalesce(json_extract(capabilities, '$.tools'), 0);--> statement-breakpoint

UPDATE attachment_provider_files SET
  file_family = (SELECT CASE protocol WHEN 'openai-responses' THEN 'openai' WHEN 'openai-completions' THEN 'openai' WHEN 'anthropic' THEN 'anthropic' END FROM providers WHERE id = provider_id),
  base_url = (SELECT rtrim(base_url, '/') FROM providers WHERE id = provider_id),
  credential_version = (SELECT credential_version FROM providers WHERE id = provider_id),
  cleanup_after = expires_at;--> statement-breakpoint
-- Unknown file families are never eligible for remote reuse or deletion.
UPDATE attachment_provider_files SET expires_at = 0, cleanup_after = 0 WHERE file_family IS NULL;--> statement-breakpoint

-- Drizzle does not model virtual tables/triggers; maintain this FTS5 index explicitly in SQL.
CREATE VIRTUAL TABLE models_fts USING fts5(search_name, content='models', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER models_fts_insert AFTER INSERT ON models BEGIN
  INSERT INTO models_fts(rowid, search_name) VALUES (new.id, new.search_name);
END;--> statement-breakpoint
CREATE TRIGGER models_fts_delete AFTER DELETE ON models BEGIN
  INSERT INTO models_fts(models_fts, rowid, search_name) VALUES ('delete', old.id, old.search_name);
END;--> statement-breakpoint
CREATE TRIGGER models_fts_update AFTER UPDATE OF search_name ON models WHEN old.search_name IS NOT new.search_name BEGIN
  INSERT INTO models_fts(models_fts, rowid, search_name) VALUES ('delete', old.id, old.search_name);
  INSERT INTO models_fts(rowid, search_name) VALUES (new.id, new.search_name);
END;--> statement-breakpoint
INSERT INTO models_fts(models_fts) VALUES ('rebuild');
