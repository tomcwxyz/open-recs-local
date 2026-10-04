CREATE TABLE "source_pipeline_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "attempt" integer NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "provider" text,
  "model" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  "error_category" text,
  "error_message" text,
  "retry_safe" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_pipeline_attempts"
  ADD CONSTRAINT "source_pipeline_attempts_source_id_sources_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_pipeline_attempts_source_stage_attempt_idx"
  ON "source_pipeline_attempts" USING btree ("source_id","stage","attempt");
--> statement-breakpoint
CREATE INDEX "source_pipeline_attempts_source_started_idx"
  ON "source_pipeline_attempts" USING btree ("source_id","started_at");
