"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

function makeCreateTeamSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(1, t("nameRequired")).max(50, t("nameTooLong")),
    slug: z
      .string()
      .min(1, t("slugRequired"))
      .max(50, t("slugTooLong"))
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t("slugInvalid")),
  })
}

type CreateTeamValues = z.infer<ReturnType<typeof makeCreateTeamSchema>>

export function CreateTeamForm() {
  const router = useRouter()
  const t = useTranslations("team.createForm")
  const createTeamSchema = makeCreateTeamSchema(t)
  const [isPending, setIsPending] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateTeamValues>({
    resolver: zodResolver(createTeamSchema),
  })

  async function onSubmit(values: CreateTeamValues) {
    setIsPending(true)
    // toast.promise returns a toast id, not the promise, so we must keep a
    // reference to the real work and await THAT - otherwise isPending resets
    // immediately and duplicate submits slip through while creation is in flight.
    const work = (async () => {
      const result = await authClient.organization.create({
        name: values.name,
        slug: values.slug,
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("createError"))
      }
      // Activate the newly created org
      if (result.data?.id) {
        await authClient.organization.setActive({ organizationId: result.data.id })
      }
      reset()
      router.refresh()
    })()
    toast.promise(work, {
      loading: t("creating"),
      success: t("createSuccess", { name: values.name }),
      error: (err: Error) => err.message ?? t("createError"),
    })
    try {
      await work
    } catch {
      // error surfaced by toast.promise; swallow here so isPending still resets
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardTitle")}</CardTitle>
        <CardDescription>{t("cardDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">{t("nameLabel")}</Label>
            <Input
              id="name"
              placeholder={t("namePlaceholder")}
              disabled={isPending}
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slug">{t("slugLabel")}</Label>
            <Input
              id="slug"
              placeholder={t("slugPlaceholder")}
              disabled={isPending}
              {...register("slug")}
            />
            {errors.slug && (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("slugHint")}</p>
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? t("submitting") : t("submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
