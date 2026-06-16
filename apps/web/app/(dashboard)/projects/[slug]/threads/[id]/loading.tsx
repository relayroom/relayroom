import { Skeleton } from "@/components/ui/skeleton"

// Fallback for a thread detail page (header + message timeline) while it streams.
export default function ThreadDetailLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-6">
      {/* Header: subject + status */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-24 rounded-md" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-72 rounded-md" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-3.5 w-24 rounded-md" />
              <Skeleton className="h-3 w-16 rounded-md" />
            </div>
            <Skeleton className="h-3.5 w-full rounded-md" />
            <Skeleton className="h-3.5 w-5/6 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
