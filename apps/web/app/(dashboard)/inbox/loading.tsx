import { Skeleton } from "@/components/ui/skeleton"

// Fallback for the personal inbox while its server component streams.
export default function InboxLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      <div className="space-y-1.5">
        <Skeleton className="h-5 w-28 rounded-md" />
        <Skeleton className="h-3 w-64 rounded-md" />
      </div>
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-start gap-3 p-4">
            <Skeleton className="mt-0.5 h-2 w-2 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-40 rounded-md" />
                <Skeleton className="h-3 w-16 rounded-md" />
              </div>
              <Skeleton className="h-3 w-3/4 rounded-md" />
            </div>
            <Skeleton className="h-3 w-12 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
