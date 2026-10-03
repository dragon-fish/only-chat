DROP INDEX `workspace_files_project_path_uq`;--> statement-breakpoint
-- SQLite only adds a NOT NULL column with a default. Every existing row is a project or a
-- conversation file (orphans included), and the update below sorts out the project ones.
ALTER TABLE `workspace_files` ADD `mount` text NOT NULL DEFAULT 'conversation';--> statement-breakpoint
UPDATE `workspace_files` SET `mount` = 'project' WHERE `project_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_user_memory_path_uq` ON `workspace_files` (`user_id`,`relative_path`) WHERE "workspace_files"."deleted_at" IS NULL AND "workspace_files"."mount" = 'memory/user';--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_project_path_uq` ON `workspace_files` (`project_id`,`mount`,`relative_path`) WHERE "workspace_files"."deleted_at" IS NULL AND "workspace_files"."project_id" IS NOT NULL;
