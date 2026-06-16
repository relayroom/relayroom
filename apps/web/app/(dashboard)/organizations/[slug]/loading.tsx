import { Skeleton } from "@/components/ui/skeleton"

export default function OrganizationDetailLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-12 shrink-0 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48 rounded-md" />
          <Skeleton className="h-4 w-24 rounded-md" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      {/* Members card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="h-3 w-40 rounded-md" />
        </div>
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-md" />
          ))}
        </div>
      </div>

      {/* Projects card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="h-3 w-48 rounded-md" />
        </div>
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      </div>

      {/* Usage chart */}
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  )
}
