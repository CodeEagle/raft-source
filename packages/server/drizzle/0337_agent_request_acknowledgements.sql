CREATE TABLE "agent_request_acknowledgements" (
	"server_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_request_acknowledgements_server_id_message_id_agent_id_pk" PRIMARY KEY("server_id","message_id","agent_id"),
	CONSTRAINT "agent_request_acknowledgements_status_check" CHECK ("agent_request_acknowledgements"."status" IN ('received', 'queued'))
);
--> statement-breakpoint
ALTER TABLE "agent_request_acknowledgements" ADD CONSTRAINT "agent_request_acknowledgements_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_request_acknowledgements" ADD CONSTRAINT "agent_request_acknowledgements_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_request_acknowledgements" ADD CONSTRAINT "agent_request_acknowledgements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_request_acknowledgements_agent_created" ON "agent_request_acknowledgements" USING btree ("agent_id","created_at");