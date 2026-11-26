CREATE TABLE `restored_cover_hashes` (
	`user_key` text NOT NULL,
	`image` text NOT NULL,
	`source_hash` text NOT NULL,
	PRIMARY KEY(`user_key`, `image`, `source_hash`)
);
--> statement-breakpoint
CREATE INDEX `restored_cover_hash_lookup` ON `restored_cover_hashes` (`user_key`,`source_hash`);