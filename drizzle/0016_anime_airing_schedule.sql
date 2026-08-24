CREATE TABLE `anime_airing_schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`title` text NOT NULL,
	`jp_title` text DEFAULT '' NOT NULL,
	`weekday` integer NOT NULL,
	`air_time` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`next_episode` integer,
	`next_air_at` integer,
	`season` text NOT NULL,
	`year` integer NOT NULL,
	`source` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`last_checked` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anime_airing_schedule_source_subject_season_idx` ON `anime_airing_schedule` (`source`,`subject_id`,`season`,`year`);
--> statement-breakpoint
CREATE INDEX `anime_airing_schedule_year_season_idx` ON `anime_airing_schedule` (`year`,`season`);
--> statement-breakpoint
CREATE INDEX `anime_airing_schedule_weekday_idx` ON `anime_airing_schedule` (`weekday`);
