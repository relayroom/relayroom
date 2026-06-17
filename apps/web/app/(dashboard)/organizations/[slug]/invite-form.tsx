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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface InviteFormProps {
  /** The org being invited to. Passed explicitly so we never rely on the
   *  session's active org (which may differ from the org being viewed). */
  organizationId: string
}

export function InviteForm({ organizationId }: InviteFormProps) {
  const router = useRouter()
  const t = useTranslations("org")
  const [isPending, setIsPending] = useState(false)

  const inviteSchema = z.object({
    email: z
      .string()
      .min(1, t("invite.emailRequired"))
      .email(t("invite.emailInvalid")),
    role: z.enum(["member", "admin"], { message: t("invite.roleRequired") }),
  })

  type InviteValues = z.infer<typeof inviteSchema>

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  })

  const roleValue = watch("role")

  async function onSubmit(values: InviteValues) {
    setIsPending(true)
    const work = (async () => {
      const result = await authClient.organization.inviteMember({
        email: values.email,
        role: values.role,
        // Target the displayed org explicitly (better-auth defaults to the
        // active org otherwise — wrong for a multi-org user viewing another org).
        organizationId,
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("invite.sendError"))
      }
      reset()
      router.refresh()
    })()
    toast.promise(work, {
      loading: t("invite.toastLoading"),
      success: t("invite.toastSuccess", { email: values.email }),
      error: (err: Error) => err.message ?? t("invite.toastError"),
    })
    try {
      await work
    } catch {
      // error surfaced by toast.promise
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="flex gap-3 items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="invite-email">{t("invite.emailLabel")}</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="teammate@example.com"
            disabled={isPending}
            {...register("email")}
          />
          {errors.email && (
            <p className="text-xs text-destructive">{errors.email.message}</p>
          )}
        </div>

        <div className="w-32 space-y-1.5">
          <Label>{t("invite.roleLabel")}</Label>
          <Select
            value={roleValue}
            onValueChange={(v) => setValue("role", v as "member" | "admin")}
            disabled={isPending}
          >
            <SelectTrigger className="mb-0 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">{t("roles.member")}</SelectItem>
              <SelectItem value="admin">{t("roles.admin")}</SelectItem>
            </SelectContent>
          </Select>
          {errors.role && (
            <p className="text-xs text-destructive">{errors.role.message}</p>
          )}
        </div>

        <Button type="submit" disabled={isPending}>
          {isPending ? t("invite.submittingButton") : t("invite.submitButton")}
        </Button>
      </div>
    </form>
  )
}
