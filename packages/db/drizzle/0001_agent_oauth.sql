-- F4: better-auth oidcProvider plugin tables
-- Required by oidcProvider() plugin (better-auth/plugins).
-- Docs: https://www.better-auth.com/docs/plugins/oidc-provider
-- Tables: better_auth_oauth_application, better_auth_oauth_access_token, better_auth_oauth_consent

CREATE TABLE "better_auth_oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false,
	"user_id" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "better_auth_oauth_application_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "better_auth_oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	CONSTRAINT "better_auth_oauth_access_token_access_token_unique" UNIQUE("access_token"),
	CONSTRAINT "better_auth_oauth_access_token_refresh_token_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "better_auth_oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text,
	"user_id" text,
	"scopes" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"consent_given" boolean
);
--> statement-breakpoint
ALTER TABLE "better_auth_oauth_application" ADD CONSTRAINT "better_auth_oauth_application_user_id_better_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_auth_oauth_access_token" ADD CONSTRAINT "better_auth_oauth_access_token_client_id_better_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."better_auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_auth_oauth_access_token" ADD CONSTRAINT "better_auth_oauth_access_token_user_id_better_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_auth_oauth_consent" ADD CONSTRAINT "better_auth_oauth_consent_client_id_better_auth_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."better_auth_oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_auth_oauth_consent" ADD CONSTRAINT "better_auth_oauth_consent_user_id_better_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."better_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "better_auth_oauth_app_user_idx" ON "better_auth_oauth_application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "better_auth_oauth_app_client_id_idx" ON "better_auth_oauth_application" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "better_auth_oauth_token_client_idx" ON "better_auth_oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "better_auth_oauth_token_user_idx" ON "better_auth_oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "better_auth_oauth_consent_client_idx" ON "better_auth_oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "better_auth_oauth_consent_user_idx" ON "better_auth_oauth_consent" USING btree ("user_id");
