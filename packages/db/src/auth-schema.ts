import { sql } from "drizzle-orm"
import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"

// ── oidcProvider plugin tables (F4: better-auth OAuth provider) ─────────────
// These tables are required by the oidcProvider() plugin from better-auth/plugins.
// Source: https://www.better-auth.com/docs/plugins/oidc-provider
// modelName mapping: oauthApplication, oauthAccessToken, oauthConsent
// We prefix with "better_auth_" to namespace them alongside the other auth tables.

export const better_auth_oauth_application = pgTable("better_auth_oauth_application", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: boolean("disabled").default(false),
  userId: text("user_id")
    .references(() => better_auth_user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [
  index("better_auth_oauth_app_user_idx").on(table.userId),
  index("better_auth_oauth_app_client_id_idx").on(table.clientId),
])

export const better_auth_oauth_access_token = pgTable("better_auth_oauth_access_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").unique(),
  refreshToken: text("refresh_token").unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  clientId: text("client_id")
    .references(() => better_auth_oauth_application.clientId, { onDelete: "cascade" }),
  userId: text("user_id")
    .references(() => better_auth_user.id, { onDelete: "cascade" }),
  scopes: text("scopes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("better_auth_oauth_token_client_idx").on(table.clientId),
  index("better_auth_oauth_token_user_idx").on(table.userId),
])

export const better_auth_oauth_consent = pgTable("better_auth_oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .references(() => better_auth_oauth_application.clientId, { onDelete: "cascade" }),
  userId: text("user_id")
    .references(() => better_auth_user.id, { onDelete: "cascade" }),
  scopes: text("scopes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  consentGiven: boolean("consent_given"),
}, (table) => [
  index("better_auth_oauth_consent_client_idx").on(table.clientId),
  index("better_auth_oauth_consent_user_idx").on(table.userId),
])

// ── End oidcProvider plugin tables ───────────────────────────────────────────

// ── Organization plugin tables ──────────────────────────────────────────────

export const better_auth_organization = pgTable("better_auth_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull(),
})

export const better_auth_member = pgTable(
  "better_auth_member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => better_auth_organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => better_auth_user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    // listOrganizations(user) filters by userId on every dashboard load.
    index("better_auth_member_user_idx").on(table.userId),
    // membership/authorization checks scope by org and by (org, user).
    index("better_auth_member_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
)

export const better_auth_invitation = pgTable(
  "better_auth_invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => better_auth_organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => better_auth_user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // listInvitations(org) and accept-invitation lookups (4b).
    index("better_auth_invitation_org_idx").on(table.organizationId),
    index("better_auth_invitation_email_idx").on(table.email),
  ],
)

// ── End organization plugin tables ──────────────────────────────────────────


export const better_auth_user = pgTable(
  "better_auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    // Optional display nickname (better-auth additionalField). Falls back to
    // `name` in the UI when unset.
    nickname: text("nickname"),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // DB-level guarantee that at most one admin can exist. Race-safe: two concurrent
    // promotions targeting different rows cannot both succeed - the second hits 23505.
    uniqueIndex("better_auth_user_single_admin")
      .on(table.role)
      .where(sql`role = 'admin'`),
  ],
)

export const better_auth_session = pgTable(
  "better_auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => better_auth_user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("better_auth_session_user_id_idx").on(table.userId)],
)

export const better_auth_account = pgTable(
  "better_auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => better_auth_user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("better_auth_account_user_id_idx").on(table.userId)],
)

export const better_auth_verification = pgTable(
  "better_auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("better_auth_verification_identifier_idx").on(table.identifier),
  ],
)
