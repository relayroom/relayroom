/**
 * OAuth Consent Page (F6a) — standard, generic OAuth 2.1 consent.
 *
 * better-auth's mcp()/oidcProvider plugin redirects here when an OAuth client
 * requests authorization with prompt=consent. It forwards exactly these params:
 *   ?consent_code=<code>   - opaque code to POST back to /api/auth/oauth2/consent
 *   ?client_id=<id>        - the registered OAuth client id
 *   ?scope=<scopes>        - space-separated STANDARD OIDC scopes (openid/profile/...)
 *
 * This is a generic consent page: it shows the client name and the requested
 * scopes, and the user approves (better-auth issues the auth code) or denies.
 *
 * The issued OAuth access token is USER-SCOPED (standard scopes only) — it is NOT
 * project-scoped.
 *
 * PROJECT BINDING + ORG-MEMBERSHIP GATE DO NOT HAPPEN HERE.
 * better-auth's /mcp/authorize does NOT forward custom authorize params (e.g. a
 * project connect_code) to this consent page — it only forwards
 * consent_code/client_id/scope. So a project-specific consent is unreachable in
 * the real flow. The project lives in the resource URL /mcp/<code>, and the
 * security gate belongs at the RESOURCE SERVER (F6b):
 *   On an agent request to /mcp/<code> with this user-scoped Bearer token, F6b
 *   validates the token -> resolves code -> project -> VERIFIES the token's user
 *   is a member of that project's org (403 if not) -> get-or-creates the
 *   agent_connection (linking access_token_id) scoped to that project.
 */
import { redirect } from "next/navigation"
import { eq } from "drizzle-orm"
import { getTranslations } from "next-intl/server"
import { db } from "@/lib/db"
import { better_auth_oauth_application } from "@relayroom/db/auth-schema"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getServerSession } from "@/lib/auth-session"
import { ConsentForm } from "./consent-form"

export const dynamic = "force-dynamic"

export async function generateMetadata() {
  const t = await getTranslations("auth.oauthConsent")
  return { title: t("pageTitle") }
}

interface Props {
  searchParams: Promise<{
    consent_code?: string
    client_id?: string
    scope?: string
  }>
}

export default async function OAuthConsentPage({ searchParams }: Props) {
  const t = await getTranslations("auth.oauthConsent")
  const { consent_code, client_id, scope } = await searchParams

  // Must have a consent_code + client_id to proceed
  if (!consent_code || !client_id) {
    return (
      <ErrorCard message={t("error.invalidRequest")} />
    )
  }

  // Require authentication — redirect to sign-in preserving this URL
  const session = await getServerSession()
  if (!session) {
    const params = new URLSearchParams({ consent_code, client_id })
    if (scope) params.set("scope", scope)
    const self = `/account/oauth-consent?${params.toString()}`
    redirect(`/account/sign-in?redirectTo=${encodeURIComponent(self)}`)
  }

  // Look up the OAuth client name for display
  const [oauthApp] = await db
    .select({ name: better_auth_oauth_application.name })
    .from(better_auth_oauth_application)
    .where(eq(better_auth_oauth_application.clientId, client_id))
    .limit(1)

  const clientName = oauthApp?.name ?? client_id

  // The requested standard OIDC scopes.
  const displayScopes = (scope ?? "openid").split(" ").filter((s) => s)

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>{t("cardTitle")}</CardTitle>
            <CardDescription>
              {t("cardDescription", { clientName })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                {t("requestedPermissionsLabel")}
              </p>
              <div className="flex flex-wrap gap-1">
                {displayScopes.map((s) => (
                  <Badge key={s} variant="secondary" className="font-mono text-xs">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("authenticatingAs", { email: session.user.email })}
            </p>

            <ConsentForm consentCode={consent_code} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

async function ErrorCard({ message }: { message: string }) {
  const t = await getTranslations("auth.oauthConsent.error")
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>{t("cardTitle")}</CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
}
