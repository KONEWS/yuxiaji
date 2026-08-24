ALTER TABLE `user_subjects` ADD `visual_subtype` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `thumbnail` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `source_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `pixiv_pid` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `author` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `twitter_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `character_tags` text DEFAULT '[]' NOT NULL;
