CREATE TABLE `operator_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`created_at` text NOT NULL,
	`received_at` text NOT NULL,
	`barangay` text NOT NULL,
	`school` text NOT NULL,
	`source_id` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`quality` text NOT NULL,
	`campus_exposure` text NOT NULL,
	`route_exposure` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operator_decisions_barangay_created` ON `operator_decisions` (`barangay`,`created_at`);