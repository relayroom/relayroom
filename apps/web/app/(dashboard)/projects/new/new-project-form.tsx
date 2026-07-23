"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"
import { ProjectIconField } from "@/components/project/project-icon-field"
import { DEFAULT_PROJECT_COLOR } from "@/lib/project-colors"
import { createProject } from "@/modules/project/actions"
import { createProjectSchema, type CreateProjectInput } from "@/modules/project/schema"
import { slugify } from "@/modules/project/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MarkdownEditor } from "@/components/markdown-editor"

export function NewProjectForm() {
  const router = useRouter()
  const t = useTranslations("project")
  // The schema carries user-facing validation copy, so it is built from the
  // `errors` translator (see modules/thread/schema.ts). Memoized because a new
  // schema object on every render would rebuild the resolver each time.
  const tErrors = useTranslations("errors")
  const schema = useMemo(() => createProjectSchema(tErrors), [tErrors])
  const [isPending, startTransition] = useTransition()
  const [description, setDescription] = useState("")

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      slug: "",
      summary: "",
      description: "",
      thumbnailColor: DEFAULT_PROJECT_COLOR,
      backgroundColor: "",
      thumbnailUrl: null,
      backgroundUrl: null,
    },
  })

  const nameValue = watch("name")
  const thumbnailColor = watch("thumbnailColor")

  // Auto-suggest slug from name (only if slug hasn't been manually edited)
  const [slugManual, setSlugManual] = useState(false)
  useEffect(() => {
    if (!slugManual && nameValue) {
      setValue("slug", slugify(nameValue), { shouldValidate: true })
    }
  }, [nameValue, slugManual, setValue])

  const onSubmit = (data: CreateProjectInput) => {
    startTransition(async () => {
      const withDesc = { ...data, description }
      const p = createProject(withDesc)
      toast.promise(p, {
        loading: t("new.form.toastCreating"),
        success: (res) => {
          if (!res.result) throw new Error(res.message)
          router.push(`/projects/${res.item.slug}`)
          return t("new.form.toastCreated", { name: res.item.name })
        },
        error: (err: Error) => err.message ?? t("new.form.toastError"),
      })
      await p.catch(() => {}) // keep the transition pending until the action settles
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Name + project icon (click the badge to pick the color) */}
      <div className="space-y-1.5">
        <Label htmlFor="name">{t("new.form.nameLabel")}</Label>
        <div className="flex items-center gap-2">
          <ProjectIconField
            name={nameValue}
            color={thumbnailColor}
            onChange={(c) => setValue("thumbnailColor", c)}
            disabled={isPending}
          />
          <Input
            id="name"
            placeholder="My Project"
            className="flex-1"
            {...register("name")}
            disabled={isPending}
          />
        </div>
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Slug */}
      <div className="space-y-1.5">
        <Label htmlFor="slug">{t("new.form.slugLabel")}</Label>
        <Input
          id="slug"
          placeholder="my-project"
          {...register("slug")}
          disabled={isPending}
          onChange={(e) => {
            setSlugManual(true)
            register("slug").onChange(e)
          }}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {t.rich("new.form.slugHint", {
            slug: () => (
              <span className="font-mono">{watch("slug") || "slug"}</span>
            ),
          })}
        </p>
        {errors.slug && (
          <p className="text-xs text-destructive">{errors.slug.message}</p>
        )}
      </div>

      {/* Summary */}
      <div className="space-y-1.5">
        <Label htmlFor="summary">{t("new.form.summaryLabel")}</Label>
        <Input
          id="summary"
          placeholder={t("new.form.summaryPlaceholder")}
          {...register("summary")}
          disabled={isPending}
          maxLength={200}
        />
        {errors.summary && (
          <p className="text-xs text-destructive">{errors.summary.message}</p>
        )}
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label>{t("new.form.descriptionLabel")}</Label>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          disabled={isPending}
          placeholder={t("new.form.descriptionPlaceholder")}
          rows={8}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          disabled={isPending}
        >
          {t("new.form.cancel")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />}
          {t("new.form.submit")}
        </Button>
      </div>
    </form>
  )
}
