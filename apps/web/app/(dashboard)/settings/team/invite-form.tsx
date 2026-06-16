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

function makeInviteSchema(t: (key: string) => string) {
  return z.object({
    email: z
      .string()
      .min(1, t("emailRequired"))
      .email(t("emailInvalid")),
    role: z.enum(["member", "admin"], { message: t("roleRequired") }),
  })
}

type InviteValues = z.infer<ReturnType<typeof makeInviteSchema>>

export function InviteForm() {
  const router = useRouter()
  const t = useTranslations("team.inviteForm")
  const inviteSchema = makeInviteSchema(t)
  const [isPending, setIsPending] = useState(false)

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
      })
      if (result.error) {
        throw new Error(result.error.message ?? t("sendError"))
      }
      reset()
      router.refresh()
    })()
    toast.promise(work, {
      loading: t("sending"),
      success: t("sendSuccess", { email: values.email }),
      error: (err: Error) => err.message ?? t("sendError"),
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
          <Label htmlFor="invite-email">{t("emailLabel")}</Label>
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
          <Label>{t("roleLabel")}</Label>
          <Select
            value={roleValue}
            onValueChange={(v) => setValue("role", v as "member" | "admin")}
            disabled={isPending}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">member</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
          {errors.role && (
            <p className="text-xs text-destructive">{errors.role.message}</p>
          )}
        </div>

        <Button type="submit" disabled={isPending}>
          {isPending ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  )
}
