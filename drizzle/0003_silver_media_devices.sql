ALTER TABLE `user_state` ADD `collections_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_state` ADD `bangumi_sync_types_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_state` ADD `openclaw_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_state` ADD `openclaw_agent` text DEFAULT 'hikari' NOT NULL;--> statement-breakpoint
CREATE TABLE `user_subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`type` text NOT NULL,
	`subject_id` integer,
	`title` text NOT NULL,
	`jp` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 12 NOT NULL,
	`status` text DEFAULT 'watching' NOT NULL,
	`kind` text DEFAULT 'coral' NOT NULL,
	`score` integer,
	`next` text,
	`image` text,
	`global_score` real,
	`source` text DEFAULT '' NOT NULL,
	`collection` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `user_subjects_user_key_idx` ON `user_subjects` (`user_key`);--> statement-breakpoint
CREATE INDEX `user_subjects_user_type_idx` ON `user_subjects` (`user_key`,`type`);--> statement-breakpoint
CREATE TABLE `user_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`sub_category` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`price` real,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`purchase_date` text,
	`receipt_image` text,
	`cover_image` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`rating` integer,
	`review` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `user_devices_user_key_idx` ON `user_devices` (`user_key`);--> statement-breakpoint
CREATE INDEX `user_devices_user_category_idx` ON `user_devices` (`user_key`,`category`);--> statement-breakpoint
CREATE INDEX `user_devices_user_status_idx` ON `user_devices` (`user_key`,`status`);
