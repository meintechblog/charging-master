CREATE TABLE `chargers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`manufacturer` text,
	`model` text,
	`efficiency` real DEFAULT 0.85,
	`max_current_a` real,
	`max_voltage_v` real,
	`output_type` text DEFAULT 'DC',
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `charger_id` integer REFERENCES chargers(id);