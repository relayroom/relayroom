import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { nextCookies } from "better-auth/next-js"
import { admin, organization, mcp } from "better-auth/plugins"
import * as authSchema from "@relayroom/db/auth-schema"
import { db } from "./db"
import { sendMail, escapeHtml } from "./email"

// ── Plugin selection rationale (F6a) ────────────────────────────────────────
// We use `mcp()` (better-auth/plugins) which is a thin wrapper around
// `oidcProvider` that adds MCP OAuth 2.1-compliant endpoints:
//   - /.well-known/oauth-authorization-server  (RFC 8414 metadata)
//   - /.well-known/oauth-protected-resource    (RFC 9728 resource metadata)
//   - /mcp/authorize                           (authorization endpoint, PKCE)
//   - /mcp/token                               (token endpoint)
//   - /mcp/register                            (Dynamic Client Registration RFC 7591)
//   - /mcp/get-session                         (validate bearer → OAuthAccessToken)
//   - /oauth2/consent                          (consent POST endpoint)
//
// Both `mcp()` and `oidcProvider()` use the same DB schema
// (oauthApplication / oauthAccessToken / oauthConsent) — no migration needed.
//
// The `consentPage` option causes the authorize flow to redirect the browser to
// /account/oauth-consent?consent_code=<code>&client_id=<id>&scope=<scopes>
// when the `prompt=consent` parameter is present. Our consent page reads the
// project connect-code from the requested scope (format: project:<connect_code>),
// verifies the user's org membership, creates the agent + agent_connection
// (storing the access_token_id after the OAuth token is minted on approval),
// and then POSTs to /api/auth/oauth2/consent { accept: true, consent_code }.
//
// Docs: https://www.better-auth.com/docs/plugins/mcp

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:48800"

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: {
    enabled: true,
    // Public self-registration is closed.  Account creation is only possible
    // through:
    //   1. The one-time admin setup server action (auth.api.createUser, gated on
    //      !adminExists()).
    //   2. The accept-invitation server action (also uses auth.api.createUser).
    // Both bypass the public /api/auth/sign-up/email endpoint entirely.
    disableSignUp: true,
  },
  user: {
    modelName: "better_auth_user",
    additionalFields: {
      // Optional display nickname; settable via updateUser. Falls back to `name`.
      nickname: { type: "string", required: false, input: true },
    },
  },
  session: { modelName: "better_auth_session" },
  account: { modelName: "better_auth_account" },
  verification: { modelName: "better_auth_verification" },
  plugins: [
    admin(),
    organization({
      schema: {
        organization: { modelName: "better_auth_organization" },
        member: { modelName: "better_auth_member" },
        invitation: { modelName: "better_auth_invitation" },
      },
      // The dashboard guard only protects the UI; the create endpoint
      // (/api/auth/organization/create) is reachable by any session, including
      // self-registered pending users. Gate it at the API level: must be admin AND
      // no organization may exist yet. The Community Edition is single-workspace;
      // multiple organizations are an Enterprise feature.
      allowUserToCreateOrganization: async (user) => {
        if ((user as { role?: string }).role !== "admin") return false
        const existing = await db
          .select({ id: authSchema.better_auth_organization.id })
          .from(authSchema.better_auth_organization)
          .limit(1)
        return existing.length === 0
      },

      async sendInvitationEmail(data) {
        // data.id is a generated invitation id (no special chars) and baseUrl is
        // server-controlled, but escape the assembled URL too for defense in depth.
        const acceptUrl = `${baseUrl}/account/accept-invitation?id=${data.id}`
        const safeUrl = escapeHtml(acceptUrl)
        const inviterName = escapeHtml(
          data.inviter.user.name ?? data.inviter.user.email,
        )
        const orgName = escapeHtml(data.organization.name)
        await sendMail({
          to: data.email,
          subject: `[RelayRoom] ${data.organization.name} 팀에 초대되었습니다`,
          html: `
            <p>안녕하세요,</p>
            <p><strong>${inviterName}</strong>님이 <strong>${orgName}</strong> 팀에 초대했습니다.</p>
            <p>아래 링크를 클릭해 계정을 만들고 팀에 참여하세요:</p>
            <p><a href="${safeUrl}">${safeUrl}</a></p>
            <p>이 초대는 48시간 후에 만료됩니다.</p>
          `,
        })
      },
    }),
    // F6a: MCP OAuth 2.1 provider (replaces bare oidcProvider from F4).
    // Schema is identical — uses the same better_auth_oauth_* tables.
    // nextCookies() MUST remain last (per better-auth docs).
    //
    // Token model (post-codex review): the issued access token authenticates the
    // USER (standard OIDC scopes only — openid/profile/email/offline_access). It is
    // NOT project-scoped. Project binding happens at the RESOURCE SERVER (F6b) via
    // the MCP URL `/mcp/<connect_code>`, where the agent_connection is get-or-created
    // and linked to access_token_id. Do not bind the project at OAuth time.
    mcp({
      loginPage: "/account/sign-in",
      oidcConfig: {
        // loginPage is required by OIDCOptions (used by the underlying oidcProvider).
        loginPage: "/account/sign-in",
        // Consent page — better-auth forwards ?consent_code=&client_id=&scope=.
        // The connect_code is carried separately (see oauth-consent/page.tsx) and
        // resolved there for the consent UX + org-membership check.
        consentPage: "/account/oauth-consent",
        // MCP OAuth 2.1 REQUIRES PKCE. requirePKCE=true rejects any authorize
        // request without code_challenge and forces the token endpoint to verify
        // the code_verifier (prevents auth-code interception). Option lives in
        // OIDCOptions (typed public API; the docs site omits it). Default is false.
        requirePKCE: true,
        // Standard OIDC scopes only (openid/profile/email/offline_access are added
        // automatically). No custom project scope — better-auth validates scopes
        // against this static list, so a dynamic project:<code> would always fail
        // invalid_scope. Project binding is the resource server's job (F6b).
        schema: {
          oauthApplication: { modelName: "better_auth_oauth_application" },
          oauthAccessToken: { modelName: "better_auth_oauth_access_token" },
          oauthConsent: { modelName: "better_auth_oauth_consent" },
        },
      },
    }),
    nextCookies(),
  ],
})
