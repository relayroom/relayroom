"use client"

import { useState } from "react"
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

// ── Schema ────────────────────────────────────────────────────────────────────

function buildSchema(t: ReturnType<typeof useTranslations<"my.profile.form">>) {
  return z.object({
    name: z
      .string()
      .min(1, t("nameRequired"))
      .max(100, t("nameTooLong")),
    nickname: z
      .string()
      .max(50, t("nicknameTooLong"))
      .optional(),
  })
}

type ProfileValues = {
  name: string
  nickname?: string
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  initialName: string
  initialNickname: string
  email: string
}

export function ProfileForm({ initialName, initialNickname, email: _email }: Props) {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)
  const t = useTranslations("my.profile.form")

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<ProfileValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: { name: initialName, nickname: initialNickname },
  })

  async function onSubmit(values: ProfileValues) {
    setIsPending(true)

    const work = (async () => {
      const result = await authClient.updateUser({
        name: values.name,
        nickname: values.nickname ?? "",
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("saveError"))
      }
      router.refresh()
    })()

    toast.promise(work, {
      loading: t("saving"),
      success: t("saveSuccess"),
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="profile-name">{t("nameLabel")}</Label>
        <Input
          id="profile-name"
          placeholder={t("namePlaceholder")}
          disabled={isPending}
          {...register("name")}
        />
        {errors.name && (
          <p className="text-xs text-destructive">{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-nickname">{t("nicknameLabel")}</Label>
        <Input
          id="profile-nickname"
          placeholder={t("nicknamePlaceholder")}
          disabled={isPending}
          {...register("nickname")}
        />
        {errors.nickname ? (
          <p className="text-xs text-destructive">{errors.nickname.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("nicknameHint")}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end">
        <Button type="submit" size="sm" disabled={isPending || !isDirty}>
          {isPending && <Loader2Icon className="h-3.5 w-3.5 mr-2 animate-spin" />}
          {t("save")}
        </Button>
      </div>
    </form>
  )
}
