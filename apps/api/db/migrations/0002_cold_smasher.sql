ALTER TABLE "session_ai_summaries" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD COLUMN "document_status" text;--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD COLUMN "document_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD CONSTRAINT "session_ai_summaries_document_type_check" CHECK (document_type IS NULL OR document_type IN ('AADHAAR', 'PAN'));--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD CONSTRAINT "session_ai_summaries_document_status_check" CHECK (document_status IS NULL OR document_status IN ('VERIFIED', 'NOT_VERIFIED', 'UNREADABLE', 'UNAVAILABLE'));--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD CONSTRAINT "session_ai_summaries_document_complete" CHECK (("session_ai_summaries"."document_type" IS NULL AND "session_ai_summaries"."document_status" IS NULL AND "session_ai_summaries"."document_checked_at" IS NULL)
          OR ("session_ai_summaries"."document_type" IS NOT NULL AND "session_ai_summaries"."document_status" IS NOT NULL AND "session_ai_summaries"."document_checked_at" IS NOT NULL));