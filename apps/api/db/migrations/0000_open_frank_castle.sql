CREATE TABLE "agent_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_max_concurrent_positive" CHECK ("agent_profiles"."max_concurrent" >= 1)
);
--> statement-breakpoint
CREATE TABLE "billing_entries" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"billed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_month" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_entries_category_check" CHECK (category IN ('SUCCESS', 'FAILED')),
	CONSTRAINT "billing_entries_amount_positive" CHECK ("billing_entries"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_templates_version_positive" CHECK ("checklist_templates"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"video_key" text NOT NULL,
	"audit_key" text NOT NULL,
	"signature_key" text NOT NULL,
	"video_sha256" char(64),
	"audit_sha256" char(64),
	"etag" text,
	"uploaded_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exports_video_sha256_hex" CHECK ("exports"."video_sha256" IS NULL OR "exports"."video_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "exports_audit_sha256_hex" CHECK ("exports"."audit_sha256" IS NULL OR "exports"."audit_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "session_ai_summaries" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"liveness_score" numeric(5, 2),
	"liveness_status" text,
	"face_match_score" numeric(5, 2),
	"ocr_status" text,
	"model_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_ai_summaries_liveness_score_range" CHECK ("session_ai_summaries"."liveness_score" IS NULL OR ("session_ai_summaries"."liveness_score" >= 0 AND "session_ai_summaries"."liveness_score" <= 100)),
	CONSTRAINT "session_ai_summaries_face_match_score_range" CHECK ("session_ai_summaries"."face_match_score" IS NULL OR ("session_ai_summaries"."face_match_score" >= 0 AND "session_ai_summaries"."face_match_score" <= 100))
);
--> statement-breakpoint
CREATE TABLE "session_checklist_items" (
	"session_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_checklist_items_session_id_item_key_pk" PRIMARY KEY("session_id","item_key"),
	CONSTRAINT "session_checklist_items_checked_at_consistent" CHECK (("session_checklist_items"."checked" = false AND "session_checklist_items"."checked_at" IS NULL) OR ("session_checklist_items"."checked" = true AND "session_checklist_items"."checked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_actor_type_check" CHECK (actor_type IN ('CUSTOMER', 'AGENT', 'SYSTEM', 'ENTERPRISE'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"language" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"agent_id" uuid,
	"room_name" text,
	"offered_to_agent_id" uuid,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"checklist_template_id" uuid,
	"consent_ok" boolean DEFAULT false NOT NULL,
	"consent_version" text,
	"consent_at" timestamp with time zone,
	"preflight_ok" boolean DEFAULT false NOT NULL,
	"preflight_at" timestamp with time zone,
	"geo_ok" boolean DEFAULT false NOT NULL,
	"gps_accuracy_m" integer,
	"geo_checked_at" timestamp with time zone,
	"ip_country" char(2),
	"quality_below_threshold" boolean DEFAULT false NOT NULL,
	"queued_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"wait_ms" integer,
	"talk_ms" integer,
	"verdict" text,
	"verdict_at" timestamp with time zone,
	"bill_category" text,
	"bill_amount_paise" integer,
	"export_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK (status IN ('CREATED', 'PREFLIGHT_FAILED', 'QUEUED', 'OFFERED', 'IN_CALL', 'APPROVED', 'REJECTED', 'ABORTED', 'DROPPED_QUEUED', 'DROPPED_IN_CALL')),
	CONSTRAINT "sessions_export_status_check" CHECK (export_status IN ('NOT_STARTED', 'EXPORTING', 'EXPORTED', 'FAILED', 'PURGED')),
	CONSTRAINT "sessions_verdict_check" CHECK (verdict IS NULL OR verdict IN ('APPROVED', 'REJECTED')),
	CONSTRAINT "sessions_bill_pair_complete" CHECK (("sessions"."bill_category" IS NULL) = ("sessions"."bill_amount_paise" IS NULL)),
	CONSTRAINT "sessions_bill_category_check" CHECK (bill_category IS NULL OR bill_category IN ('SUCCESS', 'FAILED')),
	CONSTRAINT "sessions_bill_amount_non_negative" CHECK ("sessions"."bill_amount_paise" IS NULL OR "sessions"."bill_amount_paise" >= 0),
	CONSTRAINT "sessions_wait_ms_non_negative" CHECK ("sessions"."wait_ms" IS NULL OR "sessions"."wait_ms" >= 0),
	CONSTRAINT "sessions_talk_ms_non_negative" CHECK ("sessions"."talk_ms" IS NULL OR "sessions"."talk_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_byoc_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text,
	"auth_kind" text NOT NULL,
	"secret_ref" text,
	"probe_ok_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_byoc_configs_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_byoc_configs_provider_check" CHECK (provider IN ('S3'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"routing_strategy" text DEFAULT 'fifo' NOT NULL,
	"record_from_queue" boolean DEFAULT false NOT NULL,
	"mid_call_geo_policy" text DEFAULT 'warn' NOT NULL,
	"min_video_px" integer DEFAULT 480 NOT NULL,
	"gps_max_accuracy_m" integer DEFAULT 100 NOT NULL,
	"min_mic_level" numeric(5, 2) DEFAULT '10' NOT NULL,
	"max_rtt_ms" integer DEFAULT 300 NOT NULL,
	"min_downlink_kbps" integer DEFAULT 500 NOT NULL,
	"min_lighting_score" numeric(5, 2) DEFAULT '30' NOT NULL,
	"min_stability_score" numeric(5, 2) DEFAULT '30' NOT NULL,
	"ai_required_for_verdict" boolean DEFAULT false NOT NULL,
	"offer_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"agent_reconnect_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK (status IN ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "tenants_offer_timeout_positive" CHECK ("tenants"."offer_timeout_seconds" > 0),
	CONSTRAINT "tenants_reconnect_timeout_positive" CHECK ("tenants"."agent_reconnect_timeout_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK (role IN ('AGENT', 'TENANT_ADMIN')),
	CONSTRAINT "users_status_check" CHECK (status IN ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"http_status" integer,
	"error" text,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_attempt_positive" CHECK ("webhook_deliveries"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_ref" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD'))
);
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_entries" ADD CONSTRAINT "billing_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_entries" ADD CONSTRAINT "billing_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ai_summaries" ADD CONSTRAINT "session_ai_summaries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checklist_items" ADD CONSTRAINT "session_checklist_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_offered_to_agent_id_users_id_fk" FOREIGN KEY ("offered_to_agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_checklist_template_id_checklist_templates_id_fk" FOREIGN KEY ("checklist_template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_api_keys" ADD CONSTRAINT "tenant_api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_byoc_configs" ADD CONSTRAINT "tenant_byoc_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_entries_tenant_invoice_month" ON "billing_entries" USING btree ("tenant_id","invoice_month");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_tenant_version_unique" ON "checklist_templates" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_one_active_per_tenant" ON "checklist_templates" USING btree ("tenant_id") WHERE "checklist_templates"."active";--> statement-breakpoint
CREATE INDEX "idx_session_events_session_ts" ON "session_events" USING btree ("session_id","server_ts");--> statement-breakpoint
CREATE INDEX "idx_session_events_tenant_ts" ON "session_events" USING btree ("tenant_id","server_ts");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_created" ON "sessions" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_status" ON "sessions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_agent_created" ON "sessions" USING btree ("tenant_id","agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_external_ref" ON "sessions" USING btree ("tenant_id","external_ref");--> statement-breakpoint
CREATE INDEX "idx_sessions_offer_expiry" ON "sessions" USING btree ("offer_expires_at") WHERE "sessions"."status" = 'OFFERED';--> statement-breakpoint
CREATE INDEX "idx_sessions_export_status" ON "sessions" USING btree ("export_status");--> statement-breakpoint
CREATE INDEX "idx_tenant_api_keys_tenant" ON "tenant_api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_api_keys_prefix_unique" ON "tenant_api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_unique" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_role" ON "users" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_attempt_unique" ON "webhook_deliveries" USING btree ("event_id","attempt");--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_tenant_active" ON "webhook_endpoints" USING btree ("tenant_id","active");--> statement-breakpoint
CREATE INDEX "idx_webhook_events_pending" ON "webhook_events" USING btree ("created_at") WHERE "webhook_events"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "idx_webhook_events_session" ON "webhook_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_events_tenant_status" ON "webhook_events" USING btree ("tenant_id","status");