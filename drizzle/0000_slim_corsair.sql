CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`barangay` text NOT NULL,
	`source_id` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_alert_per_barangay` ON `alerts` (`barangay`) WHERE "alerts"."active" = 1;--> statement-breakpoint
CREATE INDEX `alerts_barangay_created` ON `alerts` (`barangay`,`created_at`);--> statement-breakpoint
CREATE TABLE `desktop_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `responses` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`barangay` text NOT NULL,
	`username` text NOT NULL,
	`decision` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `responses_barangay_created` ON `responses` (`barangay`,`created_at`);--> statement-breakpoint
CREATE TABLE `stations` (
	`barangay` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`client_id` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`reason` text NOT NULL,
	`level` real,
	`temp` real,
	`humidity` real,
	`quality` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` text NOT NULL
);
