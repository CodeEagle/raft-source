CREATE TABLE "channel_workspace_bindings" (
	"channel_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mode" text DEFAULT 'reader' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_workspace_bindings_channel_id_agent_id_workspace_id_pk" PRIMARY KEY("channel_id","agent_id","workspace_id"),
	CONSTRAINT "channel_workspace_bindings_mode_check" CHECK ("channel_workspace_bindings"."mode" IN ('reader', 'writer')),
	CONSTRAINT "channel_workspace_bindings_position_check" CHECK ("channel_workspace_bindings"."position" BETWEEN 0 AND 7)
);
--> statement-breakpoint
CREATE TABLE "channel_workspace_configs" (
	"channel_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_workspace_configs_channel_id_agent_id_pk" PRIMARY KEY("channel_id","agent_id"),
	CONSTRAINT "channel_workspace_configs_revision_check" CHECK ("channel_workspace_configs"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"daemon_id" uuid NOT NULL,
	"requested_path" text NOT NULL,
	"canonical_path" text,
	"validation_status" text DEFAULT 'unverified' NOT NULL,
	"validation_message" text,
	"validated_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_validation_status_check" CHECK ("workspaces"."validation_status" IN ('unverified', 'available', 'missing', 'not_directory', 'permission_denied', 'invalid_path', 'offline', 'alias_conflict'))
);
--> statement-breakpoint
ALTER TABLE "channel_workspace_bindings" ADD CONSTRAINT "channel_workspace_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_bindings" ADD CONSTRAINT "channel_workspace_bindings_config_fk" FOREIGN KEY ("channel_id","agent_id") REFERENCES "public"."channel_workspace_configs"("channel_id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_configs" ADD CONSTRAINT "channel_workspace_configs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_workspace_configs" ADD CONSTRAINT "channel_workspace_configs_membership_fk" FOREIGN KEY ("channel_id","agent_id") REFERENCES "public"."channel_agents"("channel_id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_daemon_id_daemons_id_fk" FOREIGN KEY ("daemon_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_workspace_bindings_order" ON "channel_workspace_bindings" USING btree ("channel_id","agent_id","position");--> statement-breakpoint
CREATE INDEX "idx_channel_workspace_bindings_workspace" ON "channel_workspace_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_machine_requested_path" ON "workspaces" USING btree ("server_id","daemon_id","requested_path");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_machine_canonical_path" ON "workspaces" USING btree ("server_id","daemon_id","canonical_path") WHERE "workspaces"."canonical_path" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workspaces_machine" ON "workspaces" USING btree ("server_id","daemon_id");