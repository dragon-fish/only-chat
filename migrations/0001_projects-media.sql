CREATE TABLE `attachment_provider_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attachment_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`provider_reference` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_provider_files_uq` ON `attachment_provider_files` (`attachment_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `attachment_provider_files_expiry_idx` ON `attachment_provider_files` (`expires_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`system_prompt` text,
	`provider_id` integer,
	`model_id` text,
	`params` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_user_updated_idx` ON `projects` (`user_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `providers` ADD `native_files` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `project_id` integer REFERENCES projects(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `sessions_project_updated_idx` ON `sessions` (`project_id`,`updated_at`);