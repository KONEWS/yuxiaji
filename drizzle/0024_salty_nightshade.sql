ALTER TABLE `media_storage_links` ADD `state` text DEFAULT 'linked' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_storage_links` ADD `operation_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_storage_links` ADD `object_count` integer;--> statement-breakpoint
ALTER TABLE `media_storage_links` ADD `total_bytes` integer;--> statement-breakpoint
ALTER TABLE `media_storage_links` ADD `manifest_sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_storage_links` ADD `verified_at` integer;