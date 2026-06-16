import { Skeleton } from "@/components/ui/skeleton"

// Fallback for an event detail page while its server component streams.
export default function EventDetailLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      {/* Header: type + agent + time */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-20 rounded-md" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-56 rounded-md" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3 w-40 rounded-md" />
      </div>

      {/* Detail payload card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <Skeleton className="h-4 w-24 rounded-md" />
        {[...Array(6)].map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}
