ALTER TABLE `user_state` ADD `video_subtype_labels_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `video_subtype` text DEFAULT 'other' NOT NULL;
