"use client"

import { useRef, useState, useCallback } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UploadCloudIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ImageDropzoneProps {
  /** Storage key returned from /api/media/upload. Controlled value. */
  value?: string | null
  /** Called with the new storage key after a successful upload. */
  onChange?: (key: string) => void
  /** Called when the user clears the image. */
  onClear?: () => void
  /** "thumbnail" | "background" — controls resize bounds server-side */
  kind?: string
  /** Optionally scope the upload to an existing project */
  projectId?: string
  disabled?: boolean
  className?: string
  /** Aspect-ratio class, e.g. "aspect-video" or "aspect-square" */
  aspectClassName?: string
  label?: string
}

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"]
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Drag-drop (or click) image upload zone.
 *
 * Uploads to POST /api/media/upload with toast.promise feedback, then calls
 * onChange with the returned storage key. Shows a preview via next/image once
 * a key is set. Falls back gracefully when no image is present.
 */
export function ImageDropzone({
  value,
  onChange,
  onClear,
  kind = "thumbnail",
  projectId,
  disabled = false,
  className,
  aspectClassName = "aspect-video",
  label,
}: ImageDropzoneProps) {
  const t = useTranslations("ui")
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const upload = useCallback(
    (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        toast.error(t("imageDropzone.errorInvalidType"))
        return
      }
      if (file.size > MAX_BYTES) {
        toast.error(t("imageDropzone.errorTooLarge"))
        return
      }

      const fd = new FormData()
      fd.append("file", file)
      fd.append("kind", kind)
      if (projectId) fd.append("projectId", projectId)

      toast.promise(
        fetch("/api/media/upload", { method: "POST", body: fd }).then(async (res) => {
          const json = await res.json()
          if (!json.result) throw new Error(json.message ?? t("imageDropzone.errorUploadFailed"))
          return json as { result: true; item: { key: string; url: string } }
        }),
        {
          loading: t("imageDropzone.loading"),
          success: (data) => {
            onChange?.(data.item.key)
            return t("imageDropzone.success")
          },
          error: (err: Error) => err.message ?? t("imageDropzone.errorUploadFailedToast"),
        },
      )
    },
    [kind, projectId, onChange, t],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      upload(files[0])
    },
    [upload],
  )

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (!disabled) setIsDragging(true)
  }
  const handleDragLeave = () => setIsDragging(false)
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (!disabled) handleFiles(e.dataTransfer.files)
  }

  const previewUrl = value ? `/api/media/${value.replace(/^\/+/, "")}` : null

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <p className="text-sm font-medium leading-none">{label}</p>}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("imageDropzone.ariaUploadArea")}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        className={cn(
          "relative w-full overflow-hidden rounded-md border border-dashed transition-colors cursor-pointer",
          aspectClassName,
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border bg-muted/30 hover:bg-muted/50",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {previewUrl ? (
          <>
            <Image
              src={previewUrl}
              alt={t("imageDropzone.previewAlt")}
              fill
              className="object-cover"
              unoptimized
            />
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClear?.()
                }}
                className="absolute top-1.5 right-1.5 z-10 rounded-full bg-background/80 p-0.5 border border-border hover:bg-background transition-colors"
                aria-label={t("imageDropzone.ariaRemove")}
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <UploadCloudIcon className="h-6 w-6" />
            <p className="text-xs">{t("imageDropzone.prompt")}</p>
            <p className="text-[10px] opacity-70">{t("imageDropzone.constraints")}</p>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}
