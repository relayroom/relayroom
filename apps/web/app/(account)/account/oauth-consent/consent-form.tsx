"use client"

/**
 * ConsentForm — approve or deny an MCP OAuth authorization request.
 *
 * On approve: POSTs to /api/auth/oauth2/consent with { accept: true, consent_code }
 * On deny:    POSTs to /api/auth/oauth2/consent with { accept: false, consent_code }
 *
 * better-auth's mcp() plugin handles both cases: on accept it redirects the
 * browser to the MCP client's redirect_uri with the authorization code; on
 * deny it redirects with an error=access_denied response.
 */
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

interface Props {
  consentCode: string
}

export function ConsentForm({ consentCode }: Props) {
  const router = useRouter()
  const t = useTranslations("auth.oauthConsent")
  const [pending, setPending] = useState<"approve" | "deny" | null>(null)

  async function postConsent(accept: boolean) {
    const action = accept ? "approve" : "deny"
    setPending(action)

    try {
      // better-auth's mcp()/oidc consent endpoint returns 200 JSON with
      // { redirectURI: "<client redirect_uri>?code=...&state=..." }. The client
      // (browser fetch) sends Origin automatically, satisfying CSRF.
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      })

      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data && typeof data === "object" && "redirectURI" in data && data.redirectURI) {
          // The redirect target is the MCP client's local callback (a different
          // origin/port) — a full browser navigation, NOT router.push (which only
          // handles internal app routes and silently no-ops on external URLs).
          window.location.href = data.redirectURI as string
          return
        }
      }

      if (!accept) {
        // Deny with no redirect from the server — just leave the consent screen.
        toast.info(t("toastDenied"))
        router.push("/dashboard")
        return
      }

      toast.error(t("toastError"))
    } catch (err) {
      console.error("[ConsentForm]", err)
      toast.error(t("toastNetworkError"))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex gap-3 pt-2">
      <Button
        variant="outline"
        className="flex-1"
        disabled={pending !== null}
        onClick={() => postConsent(false)}
      >
        {pending === "deny" ? t("denyPending") : t("denyButton")}
      </Button>
      <Button
        className="flex-1"
        disabled={pending !== null}
        onClick={() => postConsent(true)}
      >
        {pending === "approve" ? t("approvePending") : t("approveButton")}
      </Button>
    </div>
  )
}
