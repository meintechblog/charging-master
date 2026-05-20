CREATE TABLE `catalog_sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer,
	`catalog_profile_id` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`commit_sha` text,
	`files_committed` integer,
	`error_message` text,
	`created_at` integer NOT NULL
);
