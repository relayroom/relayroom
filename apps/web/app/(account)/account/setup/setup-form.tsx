"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { signIn } from "@/lib/auth-client"
import { createFirstAdmin } from "./actions"
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

function useSetupSchema() {
  const t = useTranslations("auth.setup.validation")
  return z.object({
    name: z.string().min(1, t("nameRequired")),
    email: z
      .string()
      .min(1, t("emailRequired"))
      .email(t("emailInvalid")),
    password: z.string().min(8, t("passwordMinLength")),
  })
}

type SetupFormValues = {
  name: string
  email: string
  password: string
}

export function SetupForm() {
  const router = useRouter()
  const t = useTranslations("auth.setup")
  const [pending, setPending] = useState(false)

  const setupSchema = useSetupSchema()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SetupFormValues>({
    resolver: zodResolver(setupSchema),
    defaultValues: { name: "", email: "", password: "" },
  })

  const onSubmit = (values: SetupFormValues) => {
    setPending(true)
    toast.promise(
      (async () => {
        // Create the first admin via server action (bypasses disableSignUp).
        await createFirstAdmin({
          name: values.name,
          email: values.email,
          password: values.password,
        })
        // Sign in to establish a session.
        const { error } = await signIn.email({
          email: values.email,
          password: values.password,
        })
        if (error) throw new Error(error.message || t("toastError"))
        router.push("/")
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
            <Label htmlFor="name">{t("nameLabel")}</Label>
            <Input
              id="name"
              type="text"
              placeholder={t("namePlaceholder")}
              autoComplete="name"
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
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@example.com"
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
              autoComplete="new-password"
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
