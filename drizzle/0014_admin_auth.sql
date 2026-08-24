CREATE TABLE `admin_account` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text DEFAULT '' NOT NULL,
	`two_factor_enabled` integer DEFAULT false NOT NULL,
	`backup_codes` text DEFAULT '[]' NOT NULL,
	`session_duration` integer DEFAULT 2592000 NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_account_username_idx` ON `admin_account` (`username`);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`pending` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_token_idx` ON `admin_sessions` (`session_token_hash`);
CREATE INDEX `admin_sessions_expires_idx` ON `admin_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `admin_auth_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`session_id` integer,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_auth_logs_event_created_idx` ON `admin_auth_logs` (`event`,`created_at`);
