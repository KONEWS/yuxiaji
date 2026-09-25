CREATE TABLE `user_subject_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_key` text NOT NULL,
	`subject_id` integer NOT NULL,
	`thumbnail` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`image_hash` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_cover` integer DEFAULT false NOT NULL,
	`width` integer,
	`height` integer,
	`mime` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `user_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_subject_images_user_idx` ON `user_subject_images` (`user_key`);--> statement-breakpoint
CREATE INDEX `user_subject_images_subject_order_idx` ON `user_subject_images` (`subject_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_subject_images_subject_thumbnail_idx` ON `user_subject_images` (`subject_id`,`thumbnail`);
--> statement-breakpoint
/* Preserve existing gallery covers as the first normalized image. */
INSERT INTO `user_subject_images` (
  `user_key`, `subject_id`, `thumbnail`, `source_url`, `image_hash`,
  `sort_order`, `is_cover`, `mime`, `created_at`, `updated_at`
)
SELECT `user_key`, `id`, `thumbnail`, `source_url`, '', 0, 1, '', `updated_at`, `updated_at`
FROM `user_subjects`
WHERE `type` = 'visual' AND `thumbnail` <> '';
