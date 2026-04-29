CREATE TABLE `battery_health_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`session_id` integer,
	`recorded_at` integer NOT NULL,
	`total_energy_wh_ac` real NOT NULL,
	`effective_dc_wh` real NOT NULL,
	`efficiency_used` real NOT NULL,
	`peak_power_w` real,
	`duration_seconds` integer,
	`source` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `charge_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
