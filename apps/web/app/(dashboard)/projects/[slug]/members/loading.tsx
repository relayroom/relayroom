import { Skeleton } from "@/components/ui/skeleton"

export default function MembersLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-5 w-32 rounded-md" />
        <Skeleton className="h-3 w-56 rounded-md" />
      </div>

      {/* Member rows */}
      <div className="divide-y divide-border rounded-lg border border-border">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48 rounded-md" />
              <Skeleton className="h-3 w-32 rounded-md" />
            </div>
            <Skeleton className="h-5 w-20 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
