ALTER TABLE `users` ADD `enabled_models_revision` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `providers` ADD `model_revision` integer NOT NULL DEFAULT 1;
