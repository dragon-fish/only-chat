ALTER TABLE `providers` ADD `kind` text DEFAULT 'custom' NOT NULL CHECK (`kind` IN ('custom', 'codex-oauth'));
--> statement-breakpoint
CREATE TABLE `provider_oauth_credentials` (
  `provider_id` integer PRIMARY KEY NOT NULL,
  `status` text NOT NULL,
  `encrypted_bundle` text,
  `account_id` text NOT NULL,
  `account_email` text NOT NULL,
  `access_expires_at` integer,
  `revision` integer DEFAULT 1 NOT NULL,
  `last_error` text,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `provider_oauth_credentials_status_check` CHECK (`status` IN ('connected', 'reconnect-required', 'disconnected')),
  CONSTRAINT `provider_oauth_credentials_bundle_check` CHECK ((`status` = 'disconnected' AND `encrypted_bundle` IS NULL) OR (`status` IN ('connected', 'reconnect-required') AND `encrypted_bundle` IS NOT NULL))
);
