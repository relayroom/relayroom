"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

const Slider = SliderPrimitive.Root

function SliderControl({ className, ...props }: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      data-slot="slider-control"
      className={cn("flex w-full touch-none items-center py-2 select-none", className)}
      {...props}
    />
  )
}

function SliderTrack({ className, children, ...props }: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn("relative h-1.5 w-full rounded-full bg-muted", className)}
      {...props}
    >
      {children}
    </SliderPrimitive.Track>
  )
}

function SliderIndicator({ className, ...props }: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      data-slot="slider-indicator"
      className={cn("rounded-full bg-foreground", className)}
      {...props}
    />
  )
}

function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "size-4 rounded-full border border-border bg-background shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

/** Normalize base-ui's possible array value to a single number (single thumb). */
function toNumber(v: number | readonly number[]): number {
  return Array.isArray(v) ? (v[0] ?? 0) : (v as number)
}

export interface LabeledSliderProps {
  /** Human-legible label (injected from i18n). e.g. "Max auto-wakes per rolling hour". */
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onValueChange: (v: number) => void
  /** Fired on drag/keyboard commit - the save trigger. */
  onValueCommitted?: (v: number) => void
  /** Right-aligned numeric formatter (default v.toLocaleString()). */
  formatValue?: (v: number) => string
}

/**
 * Spec §11: sliders expose human-readable units, not implementation mechanics.
 * Label on the left, the numeric value on the right, the slider below.
 */
function LabeledSlider({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onValueChange,
  onValueCommitted,
  formatValue = (v) => v.toLocaleString(),
}: LabeledSliderProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="font-mono text-sm tabular-nums">{formatValue(value)}</span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onValueChange(toNumber(v))}
        onValueCommitted={
          onValueCommitted ? (v) => onValueCommitted(toNumber(v)) : undefined
        }
      >
        <SliderControl>
          <SliderTrack>
            <SliderIndicator />
            <SliderThumb />
          </SliderTrack>
        </SliderControl>
      </Slider>
    </div>
  )
}

export {
  Slider,
  SliderControl,
  SliderTrack,
  SliderIndicator,
  SliderThumb,
  LabeledSlider,
}
