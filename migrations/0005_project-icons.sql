ALTER TABLE `projects` ADD `icon_attachment_id` integer REFERENCES `attachments`(`id`) ON DELETE SET NULL;
