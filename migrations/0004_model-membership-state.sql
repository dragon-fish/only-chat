ALTER TABLE `models` ADD `manual_pinned` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `upstream_available` integer;--> statement-breakpoint
CREATE INDEX `models_provider_lab_state_idx` ON `models` (`provider_id`,`lab_id`,`enabled`,`upstream_available`,`id`);