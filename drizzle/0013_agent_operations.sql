CREATE TABLE `agent_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`source` text DEFAULT 'openclaw' NOT NULL,
	`agent` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`resource_id` integer,
	`status_code` integer DEFAULT 200 NOT NULL,
	`response_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_operations_idempotency_idx` ON `agent_operations` (`user_key`,`agent`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `agent_operations_user_created_idx` ON `agent_operations` (`user_key`,`created_at`);
