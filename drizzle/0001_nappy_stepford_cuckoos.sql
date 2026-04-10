CREATE TABLE `update_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`from_sha` text NOT NULL,
	`to_sha` text,
	`status` text NOT NULL,
	`stage` text,
	`error_message` text,
	`rollback_stage` text
);
--> statement-breakpoint
ALTER TABLE `plugs` DROP COLUMN `mqtt_topic_prefix`;