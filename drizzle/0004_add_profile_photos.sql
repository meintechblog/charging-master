CREATE TABLE `profile_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`original_name` text,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`caption` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
