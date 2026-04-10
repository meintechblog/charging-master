CREATE TABLE `charge_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plug_id` text NOT NULL,
	`profile_id` integer,
	`state` text DEFAULT 'detecting' NOT NULL,
	`detection_confidence` real,
	`curve_offset_seconds` integer,
	`target_soc` integer,
	`estimated_soc` integer,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`stop_reason` text,
	`energy_wh` real,
	`dtw_score` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plug_id`) REFERENCES `plugs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`model_name` text,
	`purchase_date` text,
	`estimated_cycles` integer,
	`target_soc` integer DEFAULT 80 NOT NULL,
	`product_url` text,
	`document_url` text,
	`manufacturer` text,
	`article_number` text,
	`gtin` text,
	`capacity_wh` real,
	`weight_grams` integer,
	`price_eur` real,
	`price_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mqtt_topic_prefix` text NOT NULL,
	`ip_address` text,
	`polling_interval` integer DEFAULT 5 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`online` integer DEFAULT false NOT NULL,
	`last_seen` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `power_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plug_id` text NOT NULL,
	`apower` real NOT NULL,
	`voltage` real,
	`current` real,
	`output` integer,
	`total_energy` real,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`plug_id`) REFERENCES `plugs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`price_eur` real NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reference_curve_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`curve_id` integer NOT NULL,
	`offset_seconds` integer NOT NULL,
	`apower` real NOT NULL,
	`voltage` real,
	`current` real,
	`cumulative_wh` real NOT NULL,
	FOREIGN KEY (`curve_id`) REFERENCES `reference_curves`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reference_curves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`start_power` real NOT NULL,
	`peak_power` real NOT NULL,
	`total_energy_wh` real NOT NULL,
	`duration_seconds` integer NOT NULL,
	`point_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `device_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`state` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `charge_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`offset_ms` integer NOT NULL,
	`apower` real NOT NULL,
	`voltage` real,
	`current` real,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `charge_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `soc_boundaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`curve_id` integer NOT NULL,
	`soc` integer NOT NULL,
	`offset_seconds` integer NOT NULL,
	`cumulative_wh` real NOT NULL,
	`expected_power` real NOT NULL,
	FOREIGN KEY (`curve_id`) REFERENCES `reference_curves`(`id`) ON UPDATE no action ON DELETE cascade
);
