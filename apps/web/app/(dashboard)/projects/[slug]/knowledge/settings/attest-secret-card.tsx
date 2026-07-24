"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { KeyRoundIcon, RotateCwIcon, CopyIcon, CheckIcon, Loader2Icon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/use-confirm"
import { rotateAttestSecret } from "@/modules/knowledge/attest-actions"
import type { RotationMode } from "@/modules/knowledge/attest-schema"

interface Props {
  projectId: string
  /** null = attestation disabled (no secret has ever been minted). */
  keyId: string | null
  prevKeyId: string | null
  /** Pre-formatted in the reader's timezone by the server. */
  prevExpiresLabel: string | null
}

/**
 * The attest secret: generate it (when off) or rotate it (when on), and show the
 * plaintext exactly once - the single moment it exists in the response.
 *
 * The plaintext lives only in component state, set from the action's return and
 * cleared when the owner dismisses it. It is never a prop, never refetched: there
 * is no read path that carries it, so a reload shows only the key id.
 */
export function AttestSecretCard({ projectId, keyId, prevKeyId, prevExpiresLabel }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)
  const [minted, setMinted] = useState<{ secret: string; keyId: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const enabled = keyId !== null

  async function onRotate(mode: RotationMode = "hygiene") {
    const revoking = mode === "revoke"
    const ok = await confirm({
      title: revoking
        ? t("knowledgeAttest.revokeConfirmTitle")
        : enabled
          ? t("knowledgeAttest.rotateConfirmTitle")
          : t("knowledgeAttest.generateConfirmTitle"),
      description: revoking
        ? t("knowledgeAttest.revokeConfirmBody")
        : enabled
          ? t("knowledgeAttest.rotateConfirmBody")
          : t("knowledgeAttest.generateConfirmBody"),
      destructive: revoking,
    })
    if (!ok) return

    setPending(true)
    const request = rotateAttestSecret(projectId, mode).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgeAttest.rotateFailed"))
      return res
    })
    toast.promise(request, {
      loading: revoking ? t("knowledgeAttest.revokePending") : t("knowledgeAttest.rotatePending"),
      success: (res) => {
        setMinted({ secret: res.item.secret, keyId: res.item.keyId })
        setCopied(false)
        return revoking ? t("knowledgeAttest.revokeDone") : t("knowledgeAttest.rotateDone")
      },
      error: (err: unknown) =>
        err instanceof Error ? err.message : t("knowledgeAttest.rotateFailed"),
    })
    await request.catch(() => {})
    setPending(false)
  }

  async function copySecret() {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.secret)
      setCopied(true)
    } catch {
      // Clipboard can be denied; the value is on screen to copy by hand.
    }
  }

  function dismissSecret() {
    // Refresh so the (now-current) key id renders from the server, then drop the
    // plaintext from memory. After this it is unrecoverable, by design.
    setMinted(null)
    router.refresh()
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {confirmDialog}

      <div className="flex items-start gap-3">
        <KeyRoundIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold">
            {enabled ? t("knowledgeAttest.enabledTitle") : t("knowledgeAttest.disabledTitle")}
          </h2>
          {!enabled && (
            <p className="mt-1 text-sm text-muted-foreground">{t("knowledgeAttest.disabledBody")}</p>
          )}
          {enabled && (
            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">{t("knowledgeAttest.currentKeyLabel")}</dt>
                <dd className="font-mono">{keyId}</dd>
              </div>
              {prevKeyId && prevExpiresLabel && (
                <div className="flex items-center gap-2">
                  <dt className="text-muted-foreground">{t("knowledgeAttest.prevKeyLabel")}</dt>
                  <dd className="font-mono">{prevKeyId}</dd>
                  <dd className="text-muted-foreground">
                    {t("knowledgeAttest.prevKeyGrace", { expires: prevExpiresLabel })}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => onRotate("hygiene")} disabled={pending}>
          {pending ? (
            <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : enabled ? (
            <RotateCwIcon className="mr-1 h-3.5 w-3.5" />
          ) : (
            <KeyRoundIcon className="mr-1 h-3.5 w-3.5" />
          )}
          {enabled ? t("knowledgeAttest.rotateButton") : t("knowledgeAttest.generateButton")}
        </Button>
      </div>

      {/* Incident path. Separated from the routine rotation above, in destructive
          tone, because it breaks running CI on purpose - and scoped honestly: it
          stops future misuse, it does not undo promotions the leaked key already
          made. Only offered when there is a live secret to revoke. */}
      {enabled && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-semibold text-destructive">
                {t("knowledgeAttest.revokeTitle")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("knowledgeAttest.revokeBody")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("knowledgeAttest.revokeScopeNote")}
              </p>
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onRotate("revoke")}
              disabled={pending}
            >
              {pending ? (
                <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldAlertIcon className="mr-1 h-3.5 w-3.5" />
              )}
              {t("knowledgeAttest.revokeButton")}
            </Button>
          </div>
        </div>
      )}

      {/* One-time secret reveal. Present only between the mint and its dismissal. */}
      {minted && (
        <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {t("knowledgeAttest.secretShownTitle")}
          </p>
          <p className="text-xs text-amber-800/80 dark:text-amber-200/70">
            {t("knowledgeAttest.secretShownBody")}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">
              {minted.secret}
            </code>
            <Button size="sm" variant="outline" onClick={copySecret}>
              {copied ? <CheckIcon className="mr-1 h-3.5 w-3.5" /> : <CopyIcon className="mr-1 h-3.5 w-3.5" />}
              {copied ? t("knowledgeAttest.secretCopied") : t("knowledgeAttest.secretCopy")}
            </Button>
          </div>
          <Button size="sm" onClick={dismissSecret}>
            {t("knowledgeAttest.secretDismiss")}
          </Button>
        </div>
      )}
    </section>
  )
}
