"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
}

// ── Form ──────────────────────────────────────────────────────────────────────

export function CreateOrganizationForm() {
  const router = useRouter()
  const t = useTranslations("org")
  const [isPending, setIsPending] = useState(false)
  const [slugManual, setSlugManual] = useState(false)

  // ── Schema (built with translated messages) ──────────────────────────────────
  const createOrgSchema = z.object({
    name: z
      .string()
      .min(1, t("form.nameRequired"))
      .max(50, t("form.nameTooLong")),
    slug: z
      .string()
      .min(1, t("form.slugRequired"))
      .max(50, t("form.slugTooLong"))
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t("form.slugInvalid")),
    description: z.string().max(300).optional(),
  })

  type CreateOrgValues = z.infer<typeof createOrgSchema>

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateOrgValues>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: "", slug: "", description: "" },
  })

  const nameValue = watch("name")

  // Auto-derive slug from name if not manually set
  useEffect(() => {
    if (!slugManual && nameValue) {
      setValue("slug", slugify(nameValue), { shouldValidate: true })
    }
  }, [nameValue, slugManual, setValue])

  async function onSubmit(values: CreateOrgValues) {
    setIsPending(true)

    const work = (async () => {
      const result = await authClient.organization.create({
        name: values.name,
        slug: values.slug,
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("form.createError"))
      }
      // Activate the newly created org
      if (result.data?.id) {
        await authClient.organization.setActive({ organizationId: result.data.id })
      }
      const slug = result.data?.slug ?? values.slug
      router.push(`/organizations/${slug}`)
    })()

    toast.promise(work, {
      loading: t("form.toastLoading"),
      success: t("form.toastSuccess", { name: values.name }),
      error: (err: Error) => err.message ?? t("form.toastError"),
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
      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="org-name">{t("form.nameLabel")}</Label>
        <Input
          id="org-name"
          placeholder={t("form.namePlaceholder")}
          disabled={isPending}
          {...register("name")}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Slug */}
      <div className="space-y-1.5">
        <Label htmlFor="org-slug">{t("form.slugLabel")}</Label>
        <div className="flex items-center gap-0">
          <span className="flex h-9 items-center rounded-l-md border border-r-0 border-border bg-muted px-3 text-sm text-muted-foreground select-none">
            /organizations/
          </span>
          <Input
            id="org-slug"
            placeholder={t("form.slugPlaceholder")}
            disabled={isPending}
            className="rounded-l-none font-mono text-sm"
            {...register("slug", {
              onChange: () => setSlugManual(true),
            })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("form.slugHint")}
        </p>
        {errors.slug && (
          <p className="text-xs text-destructive">{errors.slug.message}</p>
        )}
      </div>

      {/* Description (local only — better-auth org.create doesn't store description,
          but we keep the field for future metadata use. It's intentionally not sent.) */}
      <div className="space-y-1.5">
        <Label htmlFor="org-desc">{t("form.descLabel")}</Label>
        <Textarea
          id="org-desc"
          placeholder={t("form.descPlaceholder")}
          rows={3}
          disabled={isPending}
          className="resize-none"
          {...register("description")}
        />
        <p className="text-xs text-muted-foreground">
          {t("form.descHint")}
        </p>
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          disabled={isPending}
        >
          {t("form.cancelButton")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />}
          {t("form.submitButton")}
        </Button>
      </div>
    </form>
  )
}
