"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { saveServerBaseSchema, type SaveServerBaseInput } from "@/modules/admin/schema"
import { saveServerBaseConfig } from "@/modules/admin/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface EnvironmentsFormProps {
  /** Currently saved override (DB), or "" if none. */
  initialServerBase: string
  /** The env/default server base, shown as the fallback when the field is blank. */
  envServerBase: string
  /** Public web URL (BETTER_AUTH_URL), env-bound and read-only here. */
  publicWebUrl: string
}

export function EnvironmentsForm({ initialServerBase, envServerBase, publicWebUrl }: EnvironmentsFormProps) {
  const t = useTranslations("environments")
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SaveServerBaseInput>({
    resolver: zodResolver(saveServerBaseSchema),
    defaultValues: { serverBase: initialServerBase },
  })

  async function onSubmit(values: SaveServerBaseInput) {
    setIsPending(true)
    const work = (async () => {
      const res = await saveServerBaseConfig(values)
      if (!res.result) throw new Error(res.message ?? t("saveError"))
      router.refresh()
    })()
    toast.promise(work, {
      loading: t("toastLoading"),
      success: t("toastSuccess"),
      error: (err: Error) => err.message ?? t("saveError"),
    })
    try {
      await work
    } catch {
      // surfaced by toast.promise
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="server-base">{t("serverBaseLabel")}</Label>
        <Input
          id="server-base"
          type="url"
          inputMode="url"
          placeholder={envServerBase}
          disabled={isPending}
          {...register("serverBase")}
        />
        <p className="text-xs text-muted-foreground">{t("serverBaseHelp")}</p>
        {errors.serverBase && (
          <p className="text-xs text-destructive">{errors.serverBase.message}</p>
        )}
      </div>

      <Button type="submit" disabled={isPending}>
        {isPending ? t("savingButton") : t("saveButton")}
      </Button>

      {/* Read-only deployment values (env-bound, changed in .env not here). */}
      <div className="space-y-3 border-t border-border pt-5 text-sm">
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t("envServerBaseLabel")}</span>
          <code className="font-mono text-xs">{envServerBase}</code>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t("publicWebUrlLabel")}</span>
          <code className="font-mono text-xs">{publicWebUrl}</code>
          <span className="text-xs text-muted-foreground">{t("publicWebUrlHelp")}</span>
        </div>
      </div>
    </form>
  )
}
