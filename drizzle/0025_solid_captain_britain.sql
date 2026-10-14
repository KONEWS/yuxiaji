CREATE TABLE `mcp_oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_codes_grant_idx` ON `mcp_oauth_codes` (`grant_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_grants_owner_idx` ON `mcp_oauth_grants` (`user_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`token_type` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `mcp_oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`client_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_grant_idx` ON `mcp_oauth_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `mcp_oauth_tokens_expires_idx` ON `mcp_oauth_tokens` (`expires_at`);