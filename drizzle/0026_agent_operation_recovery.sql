ALTER TABLE `agent_operations` ADD `request_hash` text;--> statement-breakpoint
ALTER TABLE `agent_operations` ADD `retry_safe` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_operations` ADD `started_at` integer;