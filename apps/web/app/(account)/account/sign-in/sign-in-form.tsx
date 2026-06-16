"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { signIn } from "@/lib/auth-client"
import { safeRedirect } from "@/lib/redirect"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

function useSignInSchema() {
  const t = useTranslations("auth.signIn.validation")
  return z.object({
    email: z
      .string()
      .min(1, t("emailRequired"))
      .email(t("emailInvalid")),
    password: z.string().min(1, t("passwordRequired")),
  })
}

type SignInFormValues = {
  email: string
  password: string
}

export function SignInForm({
  redirectTo = "/",
  oauthResume,
}: {
  redirectTo?: string
  /** When set (MCP OAuth login), resume the authorize flow after login via a full
   * browser navigation (it 302s to the consent page → client callback). */
  oauthResume?: string
}) {
  const router = useRouter()
  const t = useTranslations("auth.signIn")
  const [pending, setPending] = useState(false)

  const signInSchema = useSignInSchema()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInFormValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })

  const onSubmit = (values: SignInFormValues) => {
    setPending(true)
    toast.promise(
      (async () => {
        const { error } = await signIn.email({
          email: values.email,
          password: values.password,
        })
        if (error) throw new Error(error.message || t("toastError"))
        if (oauthResume) {
          // Resume the MCP OAuth authorize flow (full nav so the browser follows
          // the 302 chain to the consent page / client callback).
          window.location.href = oauthResume
          return
        }
        router.push(safeRedirect(redirectTo))
        router.refresh()
      })(),
      {
        loading: t("toastLoading"),
        success: t("toastSuccess"),
        error: (err) =>
          err instanceof Error ? err.message : t("toastError"),
        finally: () => setPending(false),
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardTitle")}</CardTitle>
        <CardDescription>{t("cardDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              placeholder="email@example.com"
              autoComplete="email"
              aria-describedby={errors.email ? "email-error" : undefined}
              {...register("email")}
            />
            {errors.email && (
              <p id="email-error" className="text-sm text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              placeholder={t("passwordPlaceholder")}
              autoComplete="current-password"
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
      </CardContent>
    </Card>
  )
}
