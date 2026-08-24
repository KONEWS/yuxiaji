CREATE TABLE `bangumi_account` (
	`admin_id` integer PRIMARY KEY NOT NULL,
	`bangumi_user_id` integer NOT NULL,
	`username` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
