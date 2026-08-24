ALTER TABLE `user_state` ADD `device_category_labels_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_state` ADD `avatar_image` text DEFAULT '' NOT NULL;
