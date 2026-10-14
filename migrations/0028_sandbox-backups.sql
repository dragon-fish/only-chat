CREATE TABLE `sandbox_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`unit_kind` text NOT NULL,
	`unit_id` integer,
	`backup_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sandbox_backups_unit_check" CHECK(("sandbox_backups"."unit_kind" = 'user') = ("sandbox_backups"."unit_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `sandbox_backups_unit_idx` ON `sandbox_backups` (`user_id`,`unit_kind`,`unit_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sandbox_backups_deleted_idx` ON `sandbox_backups` (`deleted_at`);