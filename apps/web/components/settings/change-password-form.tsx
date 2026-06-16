"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Loader2Icon, EyeIcon, EyeOffIcon } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// ── Schema ────────────────────────────────────────────────────────────────────

function makeChangePasswordSchema(t: (key: string) => string) {
  return z
    .object({
      currentPassword: z.string().min(1, t("currentPasswordRequired")),
      newPassword: z
        .string()
        .min(8, t("newPasswordTooShort"))
        .max(128, t("newPasswordTooLong")),
      confirmPassword: z.string().min(1, t("confirmPasswordRequired")),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      message: t("passwordMismatch"),
      path: ["confirmPassword"],
    })
}

type ChangePasswordValues = z.infer<ReturnType<typeof makeChangePasswordSchema>>

// ── Password input with toggle ────────────────────────────────────────────────

function PasswordInput({
  id,
  placeholder,
  disabled,
  showLabel,
  hideLabel,
  ...props
}: React.ComponentProps<typeof Input> & {
  id: string
  showLabel: string
  hideLabel: string
}) {
  const [show, setShow] = useState(false)

  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        placeholder={placeholder}
        disabled={disabled}
        className="pr-10"
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={show ? hideLabel : showLabel}
      >
        {show ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </div>
  )
}

// ── Form ──────────────────────────────────────────────────────────────────────

export function ChangePasswordForm() {
  const t = useTranslations("my.password.form")
  const [isPending, setIsPending] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(makeChangePasswordSchema(t)),
  })

  async function onSubmit(values: ChangePasswordValues) {
    setIsPending(true)

    // authClient.changePassword: { currentPassword, newPassword, revokeOtherSessions? }
    // Source: better-auth docs /concepts/users-accounts#change-password
    const work = (async () => {
      const result = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("changeError"))
      }
      reset()
    })()

    toast.promise(work, {
      loading: t("changing"),
      success: t("changeSuccess"),
      error: (err: Error) => err.message ?? t("changeError"),
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Current password */}
      <div className="space-y-1.5">
        <Label htmlFor="current-password">{t("currentPasswordLabel")}</Label>
        <PasswordInput
          id="current-password"
          placeholder={t("currentPasswordPlaceholder")}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
          disabled={isPending}
          {...register("currentPassword")}
        />
        {errors.currentPassword && (
          <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
        )}
      </div>

      {/* New password */}
      <div className="space-y-1.5">
        <Label htmlFor="new-password">{t("newPasswordLabel")}</Label>
        <PasswordInput
          id="new-password"
          placeholder={t("newPasswordPlaceholder")}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
          disabled={isPending}
          {...register("newPassword")}
        />
        {errors.newPassword && (
          <p className="text-xs text-destructive">{errors.newPassword.message}</p>
        )}
      </div>

      {/* Confirm password */}
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">{t("confirmPasswordLabel")}</Label>
        <PasswordInput
          id="confirm-password"
          placeholder={t("confirmPasswordPlaceholder")}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
          disabled={isPending}
          {...register("confirmPassword")}
        />
        {errors.confirmPassword && (
          <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
        )}
      </div>

      <div className="flex items-center justify-end pt-2 border-t border-border">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending && <Loader2Icon className="h-3.5 w-3.5 mr-2 animate-spin" />}
          {t("submit")}
        </Button>
      </div>
    </form>
  )
}
