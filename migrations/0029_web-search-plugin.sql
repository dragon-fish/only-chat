-- The Tavily plugin became the web search plugin, with Tavily as one of its backends. Its fields
-- take a backend prefix, and whoever had configured it stays on Tavily: the new default is DeepSeek.
-- A secret's ciphertext is not bound to its key, so renaming the row keeps it decryptable.
INSERT INTO `plugin_configs` (`user_id`, `plugin_id`, `key`, `value`, `updated_at`)
  SELECT `user_id`, 'tavily', 'backend', '"tavily"', MAX(`updated_at`) FROM `plugin_configs`
  WHERE `plugin_id` = 'tavily' GROUP BY `user_id`;
--> statement-breakpoint
UPDATE `plugin_configs` SET `key` = 'tavily_' || `key` WHERE `plugin_id` = 'tavily' AND `key` IN ('api_key', 'search_depth');
--> statement-breakpoint
UPDATE `plugin_configs` SET `plugin_id` = 'web_search' WHERE `plugin_id` = 'tavily';
--> statement-breakpoint
UPDATE `users` SET `settings` = json_set(json_remove(`settings`, '$.plugins.tavily'), '$.plugins.web_search', json(`settings` -> '$.plugins.tavily'))
  WHERE `settings` -> '$.plugins.tavily' IS NOT NULL;
