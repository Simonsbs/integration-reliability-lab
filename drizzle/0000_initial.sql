CREATE TABLE `labs` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `labs_expiry` ON `labs` (`expires_at`);