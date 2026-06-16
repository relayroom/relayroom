import { getTranslations } from "next-intl/server"
import { SignInForm } from "./sign-in-form"
import { LoginLocaleSwitcher } from "@/components/login-locale-switcher"
import { RelayRoomMark } from "@/components/brand/relayroom-mark"
import { safeRedirect } from "@/lib/redirect"

export async function generateMetadata() {
  const t = await getTranslations("auth.signIn")
  return { title: t("pageTitle") }
}

// Params better-auth forwards to the login page when /api/auth/mcp/authorize
// needs a session. After login we re-issue them to authorize to resume the flow.
const OAUTH_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "state",
  "nonce",
  "prompt",
] as const

export default async function SignInPage(props: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await props.searchParams

  // Detect an in-progress MCP OAuth authorization (client + redirect + response_type).
  let oauthResume: string | undefined
  if (sp.client_id && sp.redirect_uri && sp.response_type) {
    const p = new URLSearchParams()
    for (const k of OAUTH_PARAMS) {
      if (sp[k]) p.set(k, sp[k]!)
    }
    oauthResume = `/api/auth/mcp/authorize?${p.toString()}`
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Brand mark — logo + wordmark on one line, like the nav/sidebar */}
        <div className="mb-6 flex items-center justify-center gap-2 text-foreground">
          <RelayRoomMark className="h-6 w-auto" />
          <span className="text-lg font-semibold tracking-tight">RelayRoom</span>
        </div>
        <SignInForm redirectTo={safeRedirect(sp.redirectTo)} oauthResume={oauthResume} />
        <LoginLocaleSwitcher />
      </div>
    </div>
  )
}
