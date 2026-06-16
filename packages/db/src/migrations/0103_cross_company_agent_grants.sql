CREATE TABLE "cross_company_agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"principal_type" text DEFAULT 'agent' NOT NULL,
	"principal_id" uuid NOT NULL,
	"target_company_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD CONSTRAINT "cross_company_agent_grants_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD CONSTRAINT "cross_company_agent_grants_principal_id_agents_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD CONSTRAINT "cross_company_agent_grants_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "cross_company_agent_grants_unique_idx" ON "cross_company_agent_grants" USING btree ("source_company_id","principal_type","principal_id","target_company_id","capability");
--> statement-breakpoint
CREATE INDEX "cross_company_agent_grants_source_principal_status_idx" ON "cross_company_agent_grants" USING btree ("source_company_id","principal_type","principal_id","status");
--> statement-breakpoint
CREATE INDEX "cross_company_agent_grants_target_status_idx" ON "cross_company_agent_grants" USING btree ("target_company_id","status");
