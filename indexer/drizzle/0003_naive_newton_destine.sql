CREATE TABLE "collection_traits" (
	"contract" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_supply" text,
	"token_count" integer DEFAULT 0 NOT NULL,
	"manifest" jsonb,
	"sampled_token_uris" jsonb,
	"last_enumerated_token_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"enumerated_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "collection_traits_status_idx" ON "collection_traits" USING btree ("status","next_attempt_at");