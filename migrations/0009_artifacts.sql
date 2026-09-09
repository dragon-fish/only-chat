ALTER TABLE `providers` ADD `default_image_model_id` text;
--> statement-breakpoint
ALTER TABLE `models` ADD `provider_metadata` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `conversations` ADD `kind` text NOT NULL DEFAULT 'chat' CHECK (`kind` IN ('chat', 'image'));
--> statement-breakpoint
ALTER TABLE `conversations` ADD `image_provider_id` integer;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `image_model_id` text;
--> statement-breakpoint
CREATE INDEX `conversations_user_kind_updated_idx` ON `conversations` (`user_id`,`kind`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `artifact_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`client_request_id` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` = 'image_generation'),
	`source` text NOT NULL CHECK (`source` IN ('studio', 'tool', 'provider_tool', 'chat_output')),
	`operation` text NOT NULL CHECK (`operation` IN ('generate', 'edit')),
	`status` text NOT NULL CHECK (`status` IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	`conversation_id` integer,
	`message_id` integer,
	`tool_call_id` text,
	`provider_id` integer,
	`provider_name` text NOT NULL,
	`interface_id` integer,
	`interface_protocol` text NOT NULL,
	`credential_version` integer NOT NULL,
	`model_id` text NOT NULL,
	`model_name` text NOT NULL,
	`prompt` text NOT NULL,
	`params` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`interface_id`) REFERENCES `provider_interfaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_runs_user_request_uq` ON `artifact_runs` (`user_id`,`client_request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_runs_workflow_uq` ON `artifact_runs` (`workflow_instance_id`);
--> statement-breakpoint
CREATE INDEX `artifact_runs_user_status_created_idx` ON `artifact_runs` (`user_id`,`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `artifact_runs_conversation_idx` ON `artifact_runs` (`conversation_id`,`id`);
--> statement-breakpoint
CREATE TABLE `artifact_run_inputs` (
	`run_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY (`run_id`,`position`),
	FOREIGN KEY (`run_id`) REFERENCES `artifact_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `artifact_run_inputs_attachment_idx` ON `artifact_run_inputs` (`attachment_id`,`run_id`);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`kind` text NOT NULL CHECK (`kind` = 'image'),
	`attachment_id` integer NOT NULL,
	`output_index` integer NOT NULL,
	`width` integer,
	`height` integer,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `artifact_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_run_output_uq` ON `artifacts` (`run_id`,`output_index`);
--> statement-breakpoint
CREATE INDEX `artifacts_user_gallery_idx` ON `artifacts` (`user_id`,`kind`,`deleted_at`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `artifacts_attachment_idx` ON `artifacts` (`attachment_id`,`id`);
--> statement-breakpoint
CREATE TABLE `artifact_links` (
	`artifact_id` integer NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`tool_call_id` text,
	`purpose` text NOT NULL CHECK (`purpose` IN ('output', 'reference')),
	PRIMARY KEY (`artifact_id`,`conversation_id`,`message_id`,`purpose`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_links_conversation_idx` ON `artifact_links` (`conversation_id`,`artifact_id`);
--> statement-breakpoint
CREATE INDEX `artifact_links_message_idx` ON `artifact_links` (`message_id`,`artifact_id`);
