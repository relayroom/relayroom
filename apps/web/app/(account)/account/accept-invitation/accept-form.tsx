"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { signIn, authClient } from "@/lib/auth-client"
import { createInvitedAccount } from "./actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function useAcceptSchema() {
  const t = useTranslations("auth.acceptInvitation.validation")
  return z.object({
    name: z.string().min(1, t("nameRequired")),
    password: z.string().min(8, t("passwordMinLength")),
  })
}

type AcceptFormValues = {
  name: string
  password: string
}

interface AcceptFormProps {
  invitationId: string
  email: string
  orgName: string
}

export function AcceptForm({ invitationId, email, orgName }: AcceptFormProps) {
  const router = useRouter()
  const t = useTranslations("auth.acceptInvitation")
  const [pending, setPending] = useState(false)

  const acceptSchema = useAcceptSchema()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AcceptFormValues>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { name: "", password: "" },
  })

  const onSubmit = (values: AcceptFormValues) => {
    setPending(true)
    toast.promise(
      (async () => {
        // 1. Create the account server-side (bypasses disableSignUp).
        const result = await createInvitedAccount(invitationId, {
          name: values.name,
          password: values.password,
        })
        if (!result.ok) throw new Error(result.error ?? t("toastError"))

        // 2. Sign in (client) → sets the session cookie.
        const { error: signInError } = await signIn.email({
          email,
          password: values.password,
        })
        if (signInError) throw new Error(signInError.message || t("toastError"))

        // 3. Accept the invitation as the now-authenticated new user → member row.
        const { error: acceptError } = await authClient.organization.acceptInvitation({
          invitationId,
        })
        if (acceptError) throw new Error(acceptError.message || t("toastError"))

        router.push("/")
        router.refresh()
      })(),
      {
        loading: t("toastLoading"),
        success: t("toastSuccess", { orgName }),
        error: (err: Error) => err.message ?? t("toastError"),
        finally: () => setPending(false),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email-display">{t("emailLabel")}</Label>
        <Input
          id="email-display"
          type="email"
          value={email}
          disabled
          className="bg-muted"
        />
        <p className="text-xs text-muted-foreground">{t("emailHelper")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">{t("nameLabel")}</Label>
        <Input
          id="name"
          type="text"
          placeholder={t("namePlaceholder")}
          autoComplete="name"
          disabled={pending}
          aria-describedby={errors.name ? "name-error" : undefined}
          {...register("name")}
        />
        {errors.name && (
          <p id="name-error" className="text-sm text-destructive">
            {errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">{t("passwordLabel")}</Label>
        <Input
          id="password"
          type="password"
          placeholder={t("passwordPlaceholder")}
          autoComplete="new-password"
          disabled={pending}
          aria-describedby={errors.password ? "password-error" : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p id="password-error" className="text-sm text-destructive">
            {errors.password.message}
          </p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("submitPending") : t("submitButton")}
      </Button>
    </form>
  )
}
