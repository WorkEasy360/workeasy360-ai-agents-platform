ALTER TABLE "organization" ADD COLUMN "conversation_retention_days" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_end_user_idx" ON "conversations" USING btree ("org_id","end_user_ref");--> statement-breakpoint
CREATE INDEX "executions_conversation_idx" ON "executions" USING btree ("conversation_id");