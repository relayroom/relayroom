import { Skeleton } from "@/components/ui/skeleton"

export default function ThreadsLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 space-y-4 max-w-6xl mx-auto">
      {/* Header + search */}
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-5 w-28 rounded-md" />
        <Skeleton className="h-8 w-56 rounded-md" />
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        {[...Array(6)].map((_, i) => (
          <Skeleton key={i} className="h-5 w-16 rounded-md" />
        ))}
      </div>

      {/* Table rows */}
      <div className="space-y-2">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 py-2">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-64 rounded-md" />
              <Skeleton className="h-3 w-40 rounded-md" />
            </div>
            <Skeleton className="h-4 w-10 rounded-md" />
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="h-4 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
