-- charge_sessions.start_total_energy and plugs.channel pre-exist on prod;
-- snapshot drift from earlier hand-edits. Filtered out of this migration.
ALTER TABLE `device_profiles` ADD `chemistry` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `cell_designation` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `cell_configuration` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `nominal_voltage_v` real;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `nominal_capacity_mah` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `max_charge_current_a` real;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `max_charge_voltage_v` real;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `charge_temp_min_c` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `charge_temp_max_c` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `discharge_temp_min_c` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `discharge_temp_max_c` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `serial_number` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `production_date` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `country_of_origin` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `certifications` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `battery_form_factor` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `replaceable` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `end_of_life_capacity_pct` integer DEFAULT 80;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `warranty_until` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `warranty_cycles` integer;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `charger_model` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `device_profiles` ADD `extra` text;