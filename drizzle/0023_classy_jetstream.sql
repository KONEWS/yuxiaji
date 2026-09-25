CREATE TABLE `media_storage_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`media_id` integer NOT NULL,
	`provider` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `user_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_storage_links_user_idx` ON `media_storage_links` (`user_key`);--> statement-breakpoint
CREATE INDEX `media_storage_links_media_idx` ON `media_storage_links` (`user_key`,`media_id`);--> statement-breakpoint
CREATE INDEX `media_storage_links_provider_path_lookup_idx` ON `media_storage_links` (`user_key`,`media_id`,`provider`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_storage_links_primary_idx` ON `media_storage_links` (`user_key`,`media_id`) WHERE `is_primary` = 1;--> statement-breakpoint
CREATE TRIGGER `media_storage_links_limit_insert`
BEFORE INSERT ON `media_storage_links`
WHEN (SELECT COUNT(*) FROM `media_storage_links` WHERE `user_key` = NEW.`user_key` AND `media_id` = NEW.`media_id`) >= 12
BEGIN
  SELECT RAISE(ABORT, 'media storage link limit exceeded');
END;
