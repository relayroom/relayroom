import { Skeleton } from "@/components/ui/skeleton"

export default function AgentDetailLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      {/* Back link */}
      <Skeleton className="h-4 w-24 rounded-md" />

      {/* Header card */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-4">
          <Skeleton className="h-14 w-14 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-5 w-48 rounded-md" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-24 rounded-md" />
              <Skeleton className="h-6 w-20 rounded-md" />
              <Skeleton className="h-6 w-28 rounded-md" />
            </div>
            <Skeleton className="h-4 w-40 rounded-md" />
          </div>
        </div>
      </div>

      {/* Usage big numbers */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <Skeleton className="h-3 w-28 rounded-md" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-16 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          ))}
        </div>
        <div className="border-t border-border pt-4">
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      </div>

      {/* Connections */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <Skeleton className="h-3 w-32 rounded-md" />
        <div className="divide-y divide-border">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-44 rounded-md" />
                <Skeleton className="h-3 w-32 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent threads + events */}
      {[...Array(2)].map((_, card) => (
        <div key={card} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <Skeleton className="h-3 w-36 rounded-md" />
          <div className="divide-y divide-border">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="my-2.5 h-5 w-full rounded-md" />
            ))}
          </div>
        </div>
      ))}

      {/* Danger zone */}
      <div className="mt-8 rounded-lg border border-destructive/30">
        <div className="border-b border-destructive/20 px-5 py-3">
          <Skeleton className="h-4 w-28 rounded-md" />
        </div>
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32 rounded-md" />
            <Skeleton className="h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>
    </div>
  )
}
