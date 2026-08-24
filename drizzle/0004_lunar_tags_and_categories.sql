ALTER TABLE `user_state` ADD `device_subcategories_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `music_album` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `music_artist` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `lyricist` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_subjects` ADD `anime_song` integer DEFAULT false NOT NULL;
