"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { FeedbackForm } from "@/components/settings/feedback-form"

/**
 * Footer "Feedback" link that opens the feedback form in a dialog. Reuses the
 * exact same FeedbackForm (and submitFeedback action) as the settings page, so
 * there is one form, not two. Closes itself on a successful send.
 */
export function FeedbackDialog({ className }: { className?: string }) {
  const t = useTranslations("feedback")
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={className}>{t("nav.tab")}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.cardTitle")}</DialogTitle>
          <DialogDescription>{t("settings.cardDescription")}</DialogDescription>
        </DialogHeader>
        <FeedbackForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
