CREATE TABLE `memory_notes` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`conversation_id` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `memory_snapshots` ADD `known` text;