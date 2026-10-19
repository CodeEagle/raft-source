CREATE TABLE "channel_workspace_task_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workspace_revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_id" text,
	"worker_pid" integer,
	"result" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_workspace_task_runs_revision_positive" CHECK ("channel_workspace_task_runs"."workspace_revision" > 0),
	CONSTRAINT "channel_workspace_task_runs_pid_positive" CHECK ("channel_workspace_task_runs"."worker_pid" IS NULL OR "channel_workspace_task_runs"."worker_pid" > 0)
);
--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_workspace_task_runs_task_unique" ON "channel_workspace_task_runs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_workspace_task_runs_request_unique" ON "channel_workspace_task_runs" USING btree ("server_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "channel_workspace_task_runs_pending_idx" ON "channel_workspace_task_runs" USING btree ("machine_id","status","created_at") WHERE "channel_workspace_task_runs"."status" IN ('queued', 'starting', 'running', 'cancel_requested', 'uncertain');