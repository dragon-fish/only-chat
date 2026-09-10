-- Drops provider_interfaces_protocol_check. Protocols are an open set owned by the llm plugin
-- registry, so a closed enum in the schema forced a table rebuild for every new protocol.
--
-- The save/restore around the rebuild is NOT optional and must survive any regeneration of this
-- file. `PRAGMA foreign_keys=OFF` is a no-op inside a transaction, which is how D1 runs migrations,
-- so `DROP TABLE provider_interfaces` fires ON DELETE actions: providers.default_interface_id and
-- artifact_runs.interface_id are `set null` and get silently wiped, and models.interface_id is
-- `no action`, which can block the DROP outright. Detaching every reference first and reattaching
-- it by the preserved row ids keeps the data intact.
CREATE TABLE `__saved_interface_refs` (
	`kind` text NOT NULL,
	`row_id` integer NOT NULL,
	`interface_id` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__saved_interface_refs` SELECT 'provider', `id`, `default_interface_id` FROM `providers` WHERE `default_interface_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `__saved_interface_refs` SELECT 'model', `id`, `interface_id` FROM `models` WHERE `interface_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `__saved_interface_refs` SELECT 'artifact_run', `id`, `interface_id` FROM `artifact_runs` WHERE `interface_id` IS NOT NULL;--> statement-breakpoint
UPDATE `providers` SET `default_interface_id` = NULL WHERE `default_interface_id` IS NOT NULL;--> statement-breakpoint
UPDATE `models` SET `interface_id` = NULL WHERE `interface_id` IS NOT NULL;--> statement-breakpoint
UPDATE `artifact_runs` SET `interface_id` = NULL WHERE `interface_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_interfaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`native_files` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_interfaces_native_files_check" CHECK(`protocol` != 'vertex-compatible' OR `native_files` = 0)
);
--> statement-breakpoint
INSERT INTO `__new_provider_interfaces`("id", "provider_id", "protocol", "base_url", "native_files", "created_at") SELECT "id", "provider_id", "protocol", "base_url", "native_files", "created_at" FROM `provider_interfaces`;--> statement-breakpoint
DROP TABLE `provider_interfaces`;--> statement-breakpoint
ALTER TABLE `__new_provider_interfaces` RENAME TO `provider_interfaces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_interfaces_provider_protocol_uq` ON `provider_interfaces` (`provider_id`,`protocol`);--> statement-breakpoint
UPDATE `providers` SET `default_interface_id` = (SELECT `interface_id` FROM `__saved_interface_refs` WHERE `kind` = 'provider' AND `row_id` = `providers`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__saved_interface_refs` WHERE `kind` = 'provider');--> statement-breakpoint
UPDATE `models` SET `interface_id` = (SELECT `interface_id` FROM `__saved_interface_refs` WHERE `kind` = 'model' AND `row_id` = `models`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__saved_interface_refs` WHERE `kind` = 'model');--> statement-breakpoint
UPDATE `artifact_runs` SET `interface_id` = (SELECT `interface_id` FROM `__saved_interface_refs` WHERE `kind` = 'artifact_run' AND `row_id` = `artifact_runs`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__saved_interface_refs` WHERE `kind` = 'artifact_run');--> statement-breakpoint
DROP TABLE `__saved_interface_refs`;
