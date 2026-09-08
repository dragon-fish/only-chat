-- OpenAI Responses emitted summaries as reasoning text, sometimes split across one item's parts.
-- The new SDK keeps only the first same-ID summary/encrypted payload, so coalesce legacy runs here.
UPDATE messages SET parts = (
  WITH normalized AS (
    SELECT part.key AS position,
      CASE WHEN json_extract(part.value, '$.type') = 'reasoning'
        AND json_type(part.value, '$.providerOptions.openai.itemId') = 'text'
        THEN json_extract(part.value, '$.providerOptions.openai.itemId') END AS item_id,
      CASE WHEN json_type(part.value, '$.providerOptions.openai') = 'object' THEN
        json_remove(json_set(part.value, '$.providerOptions.responses',
          CASE WHEN json_extract(part.value, '$.type') = 'reasoning' THEN
            json_set(json_extract(part.value, '$.providerOptions.openai'),
              '$.reasoningContent', NULL,
              '$.reasoningSummary', CASE WHEN length(json_extract(part.value, '$.text')) > 0
                THEN json_array(json_object('type', 'summary_text', 'text', json_extract(part.value, '$.text')))
                ELSE json('[]') END)
          ELSE json_extract(part.value, '$.providerOptions.openai') END), '$.providerOptions.openai')
      ELSE part.value END AS value
    FROM json_each(messages.parts) AS part
  ), boundaries AS (
    SELECT *, CASE WHEN item_id = lag(item_id) OVER (ORDER BY position) THEN 0 ELSE 1 END AS starts_run
    FROM normalized
  ), grouped AS (
    SELECT *, sum(starts_run) OVER (ORDER BY position) AS run FROM boundaries
  ), namespaces AS (
    SELECT grouped.run, grouped.position, namespace.key AS name, namespace.value
    FROM grouped, json_each(grouped.value, '$.providerOptions') AS namespace
    WHERE grouped.item_id IS NOT NULL
  ), fields AS (
    SELECT namespaces.run, namespaces.name, field.key, field.value, field.type,
      row_number() OVER (
        PARTITION BY namespaces.run, namespaces.name, field.key
        ORDER BY (namespaces.name = 'responses' AND field.key = 'reasoningEncryptedContent' AND field.type = 'null'), namespaces.position DESC
      ) AS priority
    FROM namespaces, json_each(namespaces.value) AS field
  ), namespace_objects AS (
    SELECT DISTINCT namespaces.run, namespaces.name, (
      -- json_patch would delete explicit nulls; preserve opaque JSON and the last non-null ciphertext.
      SELECT json_group_object(fields.key, json(CASE fields.type
        WHEN 'text' THEN json_quote(fields.value) WHEN 'true' THEN 'true'
        WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' ELSE fields.value END))
      FROM fields WHERE fields.run = namespaces.run AND fields.name = namespaces.name AND fields.priority = 1
    ) AS value FROM namespaces
  ), options AS (
    SELECT run, json_group_object(name, json(value)) AS value FROM namespace_objects GROUP BY run
  ), coalesced AS (
    SELECT grouped.position, CASE WHEN grouped.item_id IS NULL THEN grouped.value ELSE
      json_set(grouped.value,
        -- Preserve displayed separators, but never turn an encrypted-only run into visible plaintext.
        '$.text', (SELECT CASE WHEN sum(length(json_extract(value, '$.text'))) > 0
          THEN group_concat(json_extract(value, '$.text'), char(10)) ELSE '' END
          FROM (SELECT value FROM grouped AS entry WHERE entry.run = grouped.run ORDER BY position)),
        '$.providerOptions', json((SELECT value FROM options WHERE options.run = grouped.run)),
        '$.providerOptions.responses.reasoningSummary', json((
          SELECT json_group_array(json_object('type', 'summary_text', 'text', json_extract(value, '$.text')))
          FROM (SELECT value FROM grouped AS entry WHERE entry.run = grouped.run AND length(json_extract(value, '$.text')) > 0 ORDER BY position)
        ))) END AS value
    FROM grouped WHERE position = (SELECT min(entry.position) FROM grouped AS entry WHERE entry.run = grouped.run)
    ORDER BY grouped.position
  )
  SELECT json_group_array(json(value)) FROM coalesced
)
WHERE EXISTS (SELECT 1 FROM json_each(messages.parts) AS part WHERE json_type(part.value, '$.providerOptions.openai') = 'object');
--> statement-breakpoint
-- Match the Anthropic Files client's versioned official HTTPS root without changing gateways.
UPDATE attachment_provider_files SET base_url = 'https://api.anthropic.com/v1'
WHERE file_family = 'anthropic' AND rtrim(base_url, '/') = 'https://api.anthropic.com';
--> statement-breakpoint
-- Unscoped legacy uploads have no remotely addressable endpoint. Preserve all scoped history.
CREATE TABLE `__new_attachment_provider_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attachment_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`file_family` text NOT NULL,
	`base_url` text NOT NULL,
	`provider_reference` text NOT NULL,
	`expires_at` integer NOT NULL,
	`cleanup_after` integer DEFAULT 0 NOT NULL,
	`cleanup_attempts` integer DEFAULT 0 NOT NULL,
	`last_cleanup_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attachment_provider_files_family_check" CHECK("__new_attachment_provider_files"."file_family" IN ('openai', 'anthropic'))
);
--> statement-breakpoint
INSERT INTO `__new_attachment_provider_files`("id", "attachment_id", "provider_id", "credential_version", "file_family", "base_url", "provider_reference", "expires_at", "cleanup_after", "cleanup_attempts", "last_cleanup_error", "created_at") SELECT "id", "attachment_id", "provider_id", "credential_version", "file_family", "base_url", "provider_reference", "expires_at", "cleanup_after", "cleanup_attempts", "last_cleanup_error", "created_at" FROM `attachment_provider_files` WHERE file_family IN ('openai', 'anthropic') AND base_url IS NOT NULL AND trim(base_url) != '';--> statement-breakpoint
DROP TABLE `attachment_provider_files`;--> statement-breakpoint
ALTER TABLE `__new_attachment_provider_files` RENAME TO `attachment_provider_files`;--> statement-breakpoint
CREATE INDEX `attachment_provider_files_reuse_idx` ON `attachment_provider_files` (`attachment_id`,`provider_id`,`credential_version`,`file_family`,`base_url`,`expires_at`);--> statement-breakpoint
CREATE INDEX `attachment_provider_files_cleanup_idx` ON `attachment_provider_files` (`cleanup_after`,`expires_at`);--> statement-breakpoint
CREATE INDEX `attachment_provider_files_provider_idx` ON `attachment_provider_files` (`provider_id`,`id`);--> statement-breakpoint
ALTER TABLE `models` DROP COLUMN `display_name`;--> statement-breakpoint
ALTER TABLE `models` DROP COLUMN `capabilities`;--> statement-breakpoint
ALTER TABLE `models` DROP COLUMN `pricing`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `protocol`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `base_url`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `extra`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `native_files`;
