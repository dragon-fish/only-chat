CREATE TABLE `workspace_file_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`version` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`mime` text NOT NULL,
	`file_size` integer NOT NULL,
	`total_lines` integer NOT NULL,
	`source_conversation_id` integer,
	`source_message_id` integer,
	`tool_call_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `workspace_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_file_versions_file_version_uq` ON `workspace_file_versions` (`file_id`,`version`);--> statement-breakpoint
CREATE INDEX `workspace_file_versions_attachment_idx` ON `workspace_file_versions` (`attachment_id`);--> statement-breakpoint
CREATE TABLE `workspace_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer,
	`conversation_id` integer,
	`relative_path` text NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_project_path_uq` ON `workspace_files` (`project_id`,`relative_path`) WHERE "workspace_files"."deleted_at" IS NULL AND "workspace_files"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_conversation_path_uq` ON `workspace_files` (`conversation_id`,`relative_path`) WHERE "workspace_files"."deleted_at" IS NULL AND "workspace_files"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `workspace_files_project_idx` ON `workspace_files` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `workspace_files_conversation_idx` ON `workspace_files` (`conversation_id`,`deleted_at`);