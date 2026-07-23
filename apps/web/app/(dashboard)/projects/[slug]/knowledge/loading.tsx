import { Skeleton } from "@/components/ui/skeleton"

export default function KnowledgeLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      {/* Title + description */}
      <div className="space-y-2">
        <Skeleton className="h-5 w-28 rounded-md" />
        <Skeleton className="h-3 w-80 rounded-md" />
      </div>

      {/* State filter */}
      <div className="flex gap-2 border-b border-border pb-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-6 w-20 rounded-md" />
        ))}
      </div>

      {/* Entries */}
      <div className="divide-y divide-border rounded-lg border border-border">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="space-y-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-16 shrink-0 rounded-md" />
              <Skeleton className="h-4 flex-1 rounded-md" />
              <Skeleton className="h-5 w-20 shrink-0 rounded-md" />
            </div>
            <Skeleton className="h-3 w-full rounded-md" />
            <Skeleton className="h-3 w-2/3 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
