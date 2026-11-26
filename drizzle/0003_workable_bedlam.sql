ALTER TABLE `stations` ADD `protocol_schema` text;--> statement-breakpoint
ALTER TABLE `stations` ADD `source_kind` text;--> statement-breakpoint
ALTER TABLE `stations` ADD `packet_quality` text;--> statement-breakpoint
ALTER TABLE `stations` ADD `distance_cm` real;--> statement-breakpoint
ALTER TABLE `stations` ADD `water_calibrated` integer;--> statement-breakpoint
ALTER TABLE `stations` ADD `rain_avg_index` real;--> statement-breakpoint
ALTER TABLE `stations` ADD `rain_peak_index` real;--> statement-breakpoint
ALTER TABLE `stations` ADD `joystick_json` text;