CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`headers` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_tools` text DEFAULT '[]' NOT NULL,
	`oauth` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`config_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_servers_transport_check" CHECK("mcp_servers"."transport" IN ('http', 'sse'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_user_key_uq` ON `mcp_servers` (`user_id`,`key`);