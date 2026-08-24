ALTER TABLE `bangumi_account` ADD `token_expires_at` integer;
--> statement-breakpoint
CREATE TABLE `external_service_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`admin_id` integer NOT NULL,
	`token_ciphertext` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`last_verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `external_service_credentials_admin_idx` ON `external_service_credentials` (`admin_id`);
