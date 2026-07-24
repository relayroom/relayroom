"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, RefreshCwIcon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  /** The failed result's `message` - already localized by the query. */
  message?: string
  className?: string
}

/**
 * What a server component renders when a query FAILED, as opposed to returning
 * nothing.
 *
 * These are two different facts and they must not look alike. A skeleton says
 * "still loading", which in a server component is never true by render time - the
 * data is already decided - so a skeleton on the failure path is a spinner that
 * never resolves. An empty state says "there is nothing here", which is a claim
 * about the data we do not get to make when the read did not come back.
 *
 * Loading belongs to `loading.tsx`, which Next renders while the server component
 * is still running. This is the third state: it says the load failed, shows the
 * reason the query gave, and offers the one useful action.
 */
export function LoadError({ message, className }: Props) {
  const t = useTranslations("common")
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)

  function retry() {
    setRetrying(true)
    // Re-runs the server component. The flag is cleared by the re-render that
    // replaces this tree; if the retry fails the same way, the component mounts
    // fresh and the button is usable again.
    router.refresh()
    setTimeout(() => setRetrying(false), 1500)
  }

  return (
    <div
      className={`rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-8 text-center ${className ?? ""}`}
      role="alert"
    >
      <div className="flex justify-center">
        <div className="rounded-full bg-destructive/10 p-3">
          <AlertTriangleIcon className="h-5 w-5 text-destructive" />
        </div>
      </div>
      <p className="mt-3 text-sm font-medium">{t("loadError.title")}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        {message ?? t("loadError.body")}
      </p>
      <Button size="sm" variant="outline" className="mt-4" onClick={retry} disabled={retrying}>
        {retrying ? (
          <Loader2Icon className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCwIcon className="mr-1 h-3.5 w-3.5" />
        )}
        {t("loadError.retry")}
      </Button>
    </div>
  )
}
