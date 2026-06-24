"use client"

import { useState, useTransition, type FormEvent } from "react"
import { toast } from "sonner"
import { Loader2Icon, StarIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { submitFeedback } from "@/modules/telemetry/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * Dashboard feedback form. Message is required; rating (1-5) and contact are
 * optional. Submits via the `submitFeedback` server action, which forwards to
 * the telemetry collector. The disclosure line states exactly what is sent, so
 * this works even when telemetry is off (an explicit, consented action).
 */
export function FeedbackForm({ onSuccess }: { onSuccess?: () => void } = {}) {
  const t = useTranslations("feedback.form")
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState("")
  const [contact, setContact] = useState("")
  const [pending, startTransition] = useTransition()

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = message.trim()
    if (!trimmed) {
      toast.error(t("messageRequired"))
      return
    }
    startTransition(() => {
      const work = (async () => {
        const result = await submitFeedback({
          rating: rating ?? undefined,
          message: trimmed,
          contact: contact.trim() || undefined,
        })
        if (!result.result) throw new Error(result.message ?? t("error"))
        setRating(null)
        setMessage("")
        setContact("")
        onSuccess?.()
      })()

      toast.promise(work, {
        loading: t("sending"),
        success: t("sent"),
        error: (err: Error) => err.message ?? t("error"),
      })
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 max-w-xl">
      <div className="space-y-1.5">
        <Label>{t("ratingLabel")}</Label>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => {
            const active = rating !== null && n <= rating
            return (
              <button
                key={n}
                type="button"
                aria-label={String(n)}
                aria-pressed={active}
                onClick={() => setRating(rating === n ? null : n)}
                className="p-1 text-muted-foreground hover:text-amber-500 transition-colors"
              >
                <StarIcon
                  className={["h-5 w-5", active ? "fill-amber-400 text-amber-400" : ""].join(" ")}
                />
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="feedback-message">{t("messageLabel")}</Label>
        <Textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("messagePlaceholder")}
          rows={5}
          maxLength={2000}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="feedback-contact">{t("contactLabel")}</Label>
        <Input
          id="feedback-contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder={t("contactPlaceholder")}
          maxLength={200}
        />
      </div>

      <p className="text-xs text-muted-foreground">{t("disclosure")}</p>

      <Button type="submit" disabled={pending || message.trim().length === 0}>
        {pending && <Loader2Icon className="h-4 w-4 animate-spin" />}
        {pending ? t("sending") : t("submit")}
      </Button>
    </form>
  )
}
