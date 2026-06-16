"use client"

import { useState } from "react"
import { CheckIcon, PaletteIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ColorPickerButton } from "@/components/ui/color-picker-button"
import {
  PROJECT_COLORS,
  DEFAULT_PROJECT_COLOR,
  readableOn,
  projectInitials,
} from "@/lib/project-colors"
import { cn } from "@/lib/utils"

interface Props {
  /** Live project name - drives the initials shown in the icon/preview. */
  name: string
  color: string | null | undefined
  onChange: (color: string) => void
  disabled?: boolean
}

/**
 * Circular project icon (initials on the chosen color) that opens a dialog to
 * pick the color: large live preview + an expanded preset grid + custom picker.
 * Selection is shown with a contrast-aware check, so even a black swatch reads.
 * Used inline next to the name input in both the new and settings project forms.
 */
export function ProjectIconField({ name, color, onChange, disabled }: Props) {
  const t = useTranslations("project.icon")
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(color || DEFAULT_PROJECT_COLOR)

  const current = color || DEFAULT_PROJECT_COLOR
  const initials = projectInitials(name)

  function openDialog() {
    setDraft(current)
    setOpen(true)
  }
  function confirm() {
    onChange(draft)
    setOpen(false)
  }

  return (
    <>
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={openDialog}
                disabled={disabled}
                className="group relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full font-mono text-sm font-bold transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: current, color: readableOn(current) }}
                aria-label={t("button")}
              />
            }
          >
            <span className="transition-opacity group-hover:opacity-0">{initials}</span>
            {/* Hover overlay: reveals it is editable (color) */}
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
              <PaletteIcon className="h-4 w-4 text-white" />
            </span>
            {/* Always-visible "editable" affordance in the corner */}
            <span className="absolute -right-0.5 -bottom-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-background bg-foreground text-background">
              <PaletteIcon className="h-2.5 w-2.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("button")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
          </DialogHeader>

          {/* Live preview */}
          <div className="flex flex-col items-center gap-2 py-2">
            <div
              className="flex h-16 w-16 items-center justify-center rounded-full font-mono text-xl font-bold"
              style={{ backgroundColor: draft, color: readableOn(draft) }}
            >
              {initials}
            </div>
            <code className="font-mono text-xs text-muted-foreground">{draft}</code>
          </div>

          {/* Preset grid */}
          <div className="grid grid-cols-9 gap-2">
            {PROJECT_COLORS.map((c) => {
              const selected = draft.toLowerCase() === c.toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDraft(c)}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-full transition-transform hover:scale-110",
                    selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                >
                  {selected && <CheckIcon className="h-4 w-4" style={{ color: readableOn(c) }} />}
                </button>
              )
            })}
          </div>

          {/* Custom color */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">{t("custom")}</span>
            <ColorPickerButton value={draft} onChange={setDraft} title={t("custom")} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" onClick={confirm}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
