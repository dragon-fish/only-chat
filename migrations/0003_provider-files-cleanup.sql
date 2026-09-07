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
