ALTER TABLE "charts" ADD COLUMN "filters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "filters" jsonb DEFAULT '{}'::jsonb NOT NULL;