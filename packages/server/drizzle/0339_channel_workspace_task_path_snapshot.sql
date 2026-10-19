ALTER TABLE "channel_workspace_task_runs" ADD COLUMN "requested_path" text;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD COLUMN "canonical_workspace_path" text;--> statement-breakpoint
UPDATE "channel_workspace_task_runs" AS runs SET
  "requested_path" = workspaces."requested_path",
  "canonical_workspace_path" = COALESCE(workspaces."canonical_path", workspaces."requested_path")
FROM "workspaces"
WHERE workspaces."id" = runs."workspace_id";--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ALTER COLUMN "requested_path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ALTER COLUMN "canonical_workspace_path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_status_check" CHECK ("channel_workspace_task_runs"."status" IN ('queued', 'starting', 'running', 'cancel_requested', 'uncertain', 'succeeded', 'failed', 'cancelled', 'blocked'));--> statement-breakpoint
ALTER TABLE "channel_workspace_task_runs" ADD CONSTRAINT "channel_workspace_task_runs_paths_nonempty" CHECK (length("channel_workspace_task_runs"."requested_path") > 0 AND length("channel_workspace_task_runs"."canonical_workspace_path") > 0);
