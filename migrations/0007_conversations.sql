ALTER TABLE `sessions` RENAME TO `conversations`;
ALTER TABLE `messages` RENAME COLUMN `session_id` TO `conversation_id`;
DROP INDEX `sessions_user_updated_idx`;
DROP INDEX `sessions_project_updated_idx`;
DROP INDEX `messages_session_seq_uq`;
CREATE INDEX `conversations_user_updated_idx` ON `conversations` (`user_id`,`updated_at`);
CREATE INDEX `conversations_project_updated_idx` ON `conversations` (`project_id`,`updated_at`);
CREATE UNIQUE INDEX `messages_conversation_seq_uq` ON `messages` (`conversation_id`,`seq`);
