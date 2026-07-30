"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react"
import { MIN_LITERAL_LENGTH, type RedactionRule, type UnresolvedRule } from "@relayroom/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveRedactionRules } from "@/modules/knowledge/redaction-actions"

interface Props {
  projectId: string
  rules: RedactionRule[]
  unresolved: UnresolvedRule[]
  outdatedDetectorIds: string[]
  catalogueEmpty: boolean
}

/** Reason code to copy key. Exhaustive, so a new reason breaks the build rather than
 *  rendering an empty badge - the vocabulary lives in `shared` and this must follow it. */
function reasonKey(reason: UnresolvedRule["reason"]): string {
  switch (reason) {
    case "unknown_detector":
      return "knowledgeRedaction.reasonUnknownDetector"
    case "unknown_version":
      return "knowledgeRedaction.reasonUnknownVersion"
    case "literal_too_short":
      return "knowledgeRedaction.reasonLiteralTooShort"
    case "literal_too_long":
      return "knowledgeRedaction.reasonLiteralTooLong"
    case "legacy_patterns":
      return "knowledgeRedaction.reasonLegacyPatterns"
    case "malformed_rule":
      return "knowledgeRedaction.reasonMalformedRule"
    case "too_many_rules":
      return "knowledgeRedaction.reasonTooManyRules"
    case "broken_detector":
      return "knowledgeRedaction.reasonBrokenDetector"
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

/**
 * Owner surface for the redaction denylist.
 *
 * The card sits beside `ThreadPurgeManager` because the two are the halves of one
 * question. This one decides what future distillations may not keep; purge removes
 * what past ones already stored. Neither does the other's job, and the copy says so
 * rather than letting an owner assume that switching redaction on cleans up history.
 *
 * Literals are sent VERBATIM. Escaping happens in the shared resolver, on the server
 * side of the write - if this component escaped them, the safety of the stored value
 * would rest on a promise made in the browser, which is the argument an earlier design
 * was rejected for.
 */
export function RedactionCard({
  projectId,
  rules,
  unresolved,
  outdatedDetectorIds,
  catalogueEmpty,
}: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [literals, setLiterals] = useState<string[]>(() =>
    rules.filter((r) => r?.kind === "literal").map((r) => (r as { value: string }).value),
  )
  const [draft, setDraft] = useState("")

  // Detector rules are carried through untouched. We ship no detectors yet, so the
  // only way a project has one is a version we no longer resolve - dropping it here
  // would quietly discard configuration the owner never asked to remove.
  const detectorRules = rules.filter((r) => r?.kind === "detector")

  const legacyOnly =
    unresolved.length > 0 && unresolved.every((u) => u.reason === "legacy_patterns")

  function addLiteral() {
    const value = draft.trim()
    if (!value) return
    setLiterals((xs) => [...xs, value])
    setDraft("")
  }

  async function onSave() {
    setSaving(true)
    try {
      const next: RedactionRule[] = [
        ...detectorRules,
        ...literals.map((value) => ({ kind: "literal" as const, value })),
      ]
      const p = saveRedactionRules(projectId, next)
      toast.promise(p, {
        loading: t("knowledgeRedaction.toastSaving"),
        success: (res) => {
          if (!res.result) throw new Error(res.message ?? t("knowledgeRedaction.toastError"))
          router.refresh()
          return t("knowledgeRedaction.toastSaved")
        },
        error: (e: Error) => e.message ?? t("knowledgeRedaction.toastError"),
      })
      await p.catch(() => {})
    } finally {
      setSaving(false)
    }
  }

  const tooShort = literals.filter((l) => l.length < MIN_LITERAL_LENGTH)

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">{t("knowledgeRedaction.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("knowledgeRedaction.description")}</p>
      </div>

      {/* Stated before the controls, not after. An owner who reads this below the save
          button has already formed the belief it corrects. */}
      <div className="space-y-1 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        <p>{t("knowledgeRedaction.scopeNote")}</p>
        <p>{t("knowledgeRedaction.recoveryNote")}</p>
      </div>

      {unresolved.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
            {legacyOnly
              ? t("knowledgeRedaction.configUnsupported")
              : t("knowledgeRedaction.unresolvedTitle")}
          </p>
          {!legacyOnly && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {t("knowledgeRedaction.unresolvedHint")}
            </p>
          )}
          <ul className="space-y-0.5 text-xs text-amber-800 dark:text-amber-300">
            {unresolved.map((u, i) => (
              <li key={`${u.reason}-${i}`}>
                {t(reasonKey(u.reason))} - <span className="font-mono">{u.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold">{t("knowledgeRedaction.detectorsTitle")}</h3>
        {catalogueEmpty ? (
          // Says why it is empty and that literals are not a stopgap. A bare empty list
          // reads as an unfinished screen, and an owner waiting for detectors would
          // delay protection they can already have.
          <p className="text-xs text-muted-foreground">{t("knowledgeRedaction.detectorsEmpty")}</p>
        ) : (
          // `detectorsHint` ends by saying the built-in formats are a list of shapes we
          // thought of, not a guarantee that a secret cannot get through. Re-read that
          // sentence whenever a detector is added - this branch first renders when one
          // is. It was easy to write while the catalogue was empty and gets harder with
          // every entry, because a longer list feels more like coverage. If it has been
          // softened, the catalogue did not get more complete; we got used to it.
          <p className="text-xs text-muted-foreground">{t("knowledgeRedaction.detectorsHint")}</p>
        )}

        {/* Told, not applied. A revised detector usually widens what gets deleted, and
            redaction deletes rather than masks, so upgrading on the owner's behalf
            would destroy more of their text without asking. Saving is the upgrade. */}
        {outdatedDetectorIds.length > 0 && (
          <div className="space-y-1 rounded-md border border-border p-3">
            <p className="text-xs font-semibold">{t("knowledgeRedaction.detectorOutdated")}</p>
            <p className="text-xs text-muted-foreground">
              {t("knowledgeRedaction.detectorOutdatedHint", { count: outdatedDetectorIds.length })}
            </p>
            <ul className="font-mono text-xs text-muted-foreground">
              {outdatedDetectorIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <h3 className="text-xs font-semibold">{t("knowledgeRedaction.literalsTitle")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("knowledgeRedaction.literalsHint")}
          </p>
        </div>

        {literals.length > 0 && (
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {literals.map((value, i) => (
              <li key={`${value}-${i}`} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{value}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setLiterals((xs) => xs.filter((_, j) => j !== i))}
                  aria-label={t("knowledgeRedaction.literalRemove")}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addLiteral()
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("knowledgeRedaction.literalPlaceholder")}
            disabled={saving}
            className="h-8 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={saving || !draft.trim()}>
            <PlusIcon className="mr-1 h-3.5 w-3.5" />
            {t("knowledgeRedaction.literalAdd")}
          </Button>
        </form>

        {/* Says what a short literal DOES, not what the rule is. A rule invites padding
            it to four characters; the consequence invites reconsidering the entry. */}
        {tooShort.length > 0 && (
          <p className="text-xs text-destructive">{t("knowledgeRedaction.literalTooShortHint")}</p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving && <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t("knowledgeRedaction.save")}
        </Button>
        {literals.length === 0 && detectorRules.length === 0 && (
          <span className="text-xs text-muted-foreground">{t("knowledgeRedaction.empty")}</span>
        )}
      </div>
    </section>
  )
}
