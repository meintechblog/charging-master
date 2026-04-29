CREATE TABLE `soc_corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`predicted_soc` integer NOT NULL,
	`corrected_soc` integer NOT NULL,
	`charged_wh_at_correction` real NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `charge_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
