DROP TABLE `memory_snapshots`;--> statement-breakpoint
ALTER TABLE `messages` ADD `notes` text;--> statement-breakpoint
CREATE TABLE `memory_state` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`project_id` integer,
	`scopes` text NOT NULL,
	`known` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
