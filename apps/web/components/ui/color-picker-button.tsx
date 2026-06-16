"use client"

import { Pipette } from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
  title?: string
  className?: string
}

/**
 * Custom-color swatch shown after the preset palette. Renders an eyedropper icon
 * (instead of the native color input's square swatch); the real `<input
 * type="color">` is overlaid transparently so clicking opens the OS color picker.
 */
export function ColorPickerButton({ value, onChange, disabled, title, className }: Props) {
  return (
    <label
      className={cn(
        "relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:text-foreground",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      title={title}
    >
      <Pipette className="h-3.5 w-3.5" />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={title}
      />
    </label>
  )
}
