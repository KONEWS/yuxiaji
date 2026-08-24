CREATE TABLE `user_state` (
	`user_key` text PRIMARY KEY NOT NULL,
	`anime_json` text NOT NULL,
	`font` text DEFAULT 'modern' NOT NULL,
	`softness` integer DEFAULT 72 NOT NULL,
	`background_version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
