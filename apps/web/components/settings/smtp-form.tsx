"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  saveSmtpConfigSchema,
  SMTP_ENCRYPTIONS,
  SMTP_ENCRYPTION_PORTS,
  type SaveSmtpConfigInput,
  type SaveSmtpConfigValues,
  type SmtpEncryption,
} from "@/modules/admin/schema"
import { saveSmtpConfig, sendTestEmail } from "@/modules/admin/actions"
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

interface Props {
  initial: {
    host: string
    port: number
    user: string
    from: string
    encryption: SmtpEncryption
    hasPassword: boolean
  } | null
  testEmail: string
}

export function SmtpForm({ initial, testEmail }: Props) {
  const router = useRouter()
  const t = useTranslations("admin.smtp")
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    watch,
    formState: { errors },
  } = useForm<SaveSmtpConfigInput, unknown, SaveSmtpConfigValues>({
    resolver: zodResolver(saveSmtpConfigSchema),
    defaultValues: {
      host: initial?.host ?? "",
      port: initial?.port ?? 587,
      user: initial?.user ?? "",
      pass: "",
      from: initial?.from ?? "",
      encryption: initial?.encryption ?? "starttls",
    },
  })

  const encryption = watch("encryption") ?? "starttls"

  // Picking a preset fills the conventional port. The admin can still override
  // the port afterwards for non-standard servers.
  function onEncryptionChange(value: SmtpEncryption) {
    setValue("encryption", value, { shouldDirty: true })
    setValue("port", SMTP_ENCRYPTION_PORTS[value], { shouldDirty: true })
  }

  const passwordPlaceholder = initial?.hasPassword
    ? t("passwordSetPlaceholder")
    : t("passwordPlaceholder")

  async function onSubmit(values: SaveSmtpConfigValues) {
    setIsSaving(true)
    const work = (async () => {
      const result = await saveSmtpConfig(values)
      if (!result.result) throw new Error(result.message ?? t("saveError"))
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
      setIsSaving(false)
    }
  }

  async function onTest() {
    setIsTesting(true)
    const values = getValues()
    const work = (async () => {
      const result = await sendTestEmail(values)
      if (!result.result) throw new Error(result.message ?? t("testError"))
    })()

    toast.promise(work, {
      loading: t("testing"),
      success: t("testSuccess", { email: testEmail }),
      error: (err: Error) => err.message ?? t("testError"),
    })

    try {
      await work
    } catch {
      // surfaced by toast.promise
    } finally {
      setIsTesting(false)
    }
  }

  const busy = isSaving || isTesting

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="smtp-host">{t("hostLabel")}</Label>
        <Input
          id="smtp-host"
          placeholder={t("hostPlaceholder")}
          disabled={busy}
          {...register("host")}
        />
        {errors.host && <p className="text-xs text-destructive">{errors.host.message}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="smtp-encryption">{t("encryptionLabel")}</Label>
          <Select
            value={encryption}
            onValueChange={(value) => onEncryptionChange(value as SmtpEncryption)}
            disabled={busy}
          >
            <SelectTrigger id="smtp-encryption" className="w-full">
              <SelectValue>
                {(value) => t(`encryption.${(value as SmtpEncryption) ?? "starttls"}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {SMTP_ENCRYPTIONS.map((enc) => (
                <SelectItem key={enc} value={enc}>
                  {t(`encryption.${enc}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("encryptionHint")}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="smtp-port">{t("portLabel")}</Label>
          <Input
            id="smtp-port"
            type="number"
            placeholder="587"
            disabled={busy}
            {...register("port", { valueAsNumber: true })}
          />
          {errors.port && <p className="text-xs text-destructive">{errors.port.message}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="smtp-user">{t("userLabel")}</Label>
        <Input
          id="smtp-user"
          placeholder={t("userPlaceholder")}
          disabled={busy}
          {...register("user")}
        />
        {errors.user && <p className="text-xs text-destructive">{errors.user.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="smtp-pass">{t("passwordLabel")}</Label>
        <Input
          id="smtp-pass"
          type="password"
          placeholder={passwordPlaceholder}
          autoComplete="new-password"
          disabled={busy}
          {...register("pass")}
        />
        <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="smtp-from">{t("fromLabel")}</Label>
        <Input
          id="smtp-from"
          placeholder={t("fromPlaceholder")}
          disabled={busy}
          {...register("from")}
        />
        {errors.from && <p className="text-xs text-destructive">{errors.from.message}</p>}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onTest}>
          {isTesting && <Loader2Icon className="h-3.5 w-3.5 mr-2 animate-spin" />}
          {t("sendTest")}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {isSaving && <Loader2Icon className="h-3.5 w-3.5 mr-2 animate-spin" />}
          {t("save")}
        </Button>
      </div>
    </form>
  )
}
