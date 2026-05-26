CREATE TABLE "activity" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"contract" text NOT NULL,
	"token_id" text,
	"from_addr" text,
	"to_addr" text,
	"price" text,
	"block_number" integer NOT NULL,
	"timestamp" timestamp NOT NULL,
	CONSTRAINT "activity_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"address" text PRIMARY KEY NOT NULL,
	"name" text,
	"symbol" text,
	"total_supply" text,
	"is_721" boolean DEFAULT false NOT NULL,
	"is_1155" boolean DEFAULT false NOT NULL,
	"first_seen_block" integer,
	"metadata_checked" boolean DEFAULT false NOT NULL,
	"metadata_broken" boolean DEFAULT false NOT NULL,
	"token_uri_template" text,
	"sample_image_url" text,
	"image_url_template" text,
	"is_on_chain_metadata" boolean DEFAULT false NOT NULL,
	"tier" smallint DEFAULT 1 NOT NULL,
	"transfer_count" integer DEFAULT 0 NOT NULL,
	"mint_count" integer DEFAULT 0 NOT NULL,
	"unique_holders" integer DEFAULT 0 NOT NULL,
	"unique_senders" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawler_state" (
	"topic" text PRIMARY KEY NOT NULL,
	"last_block_processed" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"contract" text NOT NULL,
	"token_id" text NOT NULL,
	"owner" text,
	"image_url" text,
	"name" text,
	"description" text,
	"metadata_json" jsonb,
	"attributes" jsonb,
	"last_transfer_block" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_contract_token_id_pk" PRIMARY KEY("contract","token_id")
);
--> statement-breakpoint
CREATE INDEX "activity_contract_idx" ON "activity" USING btree ("contract","block_number");--> statement-breakpoint
CREATE INDEX "activity_block_idx" ON "activity" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "collections_tier_idx" ON "collections" USING btree ("tier");--> statement-breakpoint
CREATE INDEX "collections_name_idx" ON "collections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tokens_owner_idx" ON "tokens" USING btree ("owner");