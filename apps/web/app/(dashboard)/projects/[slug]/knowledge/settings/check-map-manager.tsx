"use client"

import { useMemo, useState } from "react"
import { LoadError } from "@/components/load-error"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { PlusIcon, XIcon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useConfirm } from "@/components/ui/use-confirm"
import { addCheckMapping, removeCheckMapping } from "@/modules/knowledge/attest-actions"
import { addCheckMappingSchema, type AddCheckMappingInput } from "@/modules/knowledge/attest-schema"

/** A claim this project has, offered as a mapping target. */
export interface ClaimOption {
  id: string
  title: string
  kind: string
}

export interface MappingRow {
  id: string
  checkName: string
  knowledgeTitle: string
  knowledgeKind: string
  addedLabel: string
}

interface Props {
  projectId: string
  /** The project's own claims - the picker never offers another project's id. */
  claims: ClaimOption[]
  mappings: MappingRow[]
  /**
   * Set when the claim list failed to load. Without it an empty picker reads as
   * "this project has no claims to map", which is a statement about the data we
   * did not manage to read.
   */
  claimsError?: string
}

/**
 * Owner surface for check -> claim mappings.
 *
 * The claim is chosen from a native select of THIS project's claims, so a
 * cross-project id cannot be selected in the first place; the action and the
 * composite FK reject one anyway. The check name is free text because the CI
 * author, not us, owns what a check is called.
 */
export function CheckMapManager({ projectId, claims, mappings, claimsError }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const tErrors = useTranslations("errors")
  const schema = useMemo(() => addCheckMappingSchema(tErrors), [tErrors])
  const [removingId, setRemovingId] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddCheckMappingInput>({
    resolver: zodResolver(schema),
    defaultValues: { projectId, knowledgeId: "", checkName: "" },
  })

  async function onAdd(values: AddCheckMappingInput) {
    const request = addCheckMapping(values).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgeAttest.mapFailed"))
      return res
    })
    toast.promise(request, {
      loading: t("knowledgeAttest.mapPending"),
      success: () => {
        reset({ projectId, knowledgeId: "", checkName: "" })
        router.refresh()
        return t("knowledgeAttest.mapDone")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgeAttest.mapFailed")),
    })
    await request.catch(() => {})
  }

  async function onRemove(row: MappingRow) {
    const ok = await confirm({
      title: t("knowledgeAttest.mapRemoveConfirmTitle"),
      description: t("knowledgeAttest.mapRemoveConfirmBody"),
      destructive: true,
    })
    if (!ok) return
    setRemovingId(row.id)
    const request = removeCheckMapping(row.id).then((res) => {
      if (!res.result) throw new Error(res.message ?? t("knowledgeAttest.mapFailed"))
      return res
    })
    toast.promise(request, {
      loading: t("knowledgeAttest.mapRemovePending"),
      success: () => {
        router.refresh()
        return t("knowledgeAttest.mapRemoveDone")
      },
      error: (err: unknown) => (err instanceof Error ? err.message : t("knowledgeAttest.mapFailed")),
    })
    await request.catch(() => {})
    setRemovingId(null)
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {confirmDialog}
      <div>
        <h2 className="text-sm font-semibold">{t("knowledgeAttest.mapTitle")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("knowledgeAttest.mapDescription")}</p>
      </div>

      <form onSubmit={handleSubmit(onAdd)} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1 space-y-1.5">
          <Label htmlFor="checkName" className="text-xs">
            {t("knowledgeAttest.mapCheckNameLabel")}
          </Label>
          <Input
            id="checkName"
            placeholder={t("knowledgeAttest.mapCheckNamePlaceholder")}
            className="font-mono text-sm"
            {...register("checkName")}
          />
          {errors.checkName && (
            <p className="text-xs text-destructive">{errors.checkName.message}</p>
          )}
        </div>
        <div className="min-w-[14rem] flex-1 space-y-1.5">
          <Label htmlFor="knowledgeId" className="text-xs">
            {t("knowledgeAttest.mapClaimLabel")}
          </Label>
          {claimsError && <LoadError variant="inline" className="mb-2" message={claimsError} />}
          <select
            id="knowledgeId"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            defaultValue=""
            {...register("knowledgeId")}
          >
            <option value="" disabled>
              {t("knowledgeAttest.mapClaimPlaceholder")}
            </option>
            {claims.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          {errors.knowledgeId && (
            <p className="text-xs text-destructive">{errors.knowledgeId.message}</p>
          )}
        </div>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlusIcon className="mr-1 h-3.5 w-3.5" />
          )}
          {t("knowledgeAttest.mapAddButton")}
        </Button>
      </form>

      {mappings.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("knowledgeAttest.mapEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {mappings.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <code className="shrink-0 font-mono text-xs">{m.checkName}</code>
              <span className="text-muted-foreground">→</span>
              <span className="min-w-0 flex-1 truncate">{m.knowledgeTitle}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground font-mono">{m.addedLabel}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(m)}
                disabled={removingId !== null}
                aria-label={t("knowledgeAttest.mapRemove")}
              >
                <XIcon className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
