import { Skeleton } from "@/components/ui/skeleton"

export default function ProjectOverviewLoading() {
  return (
    <div className="py-6 px-4 xs:px-6 space-y-6 max-w-6xl mx-auto">
      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-4 space-y-2"
          >
            <Skeleton className="h-3 w-20 rounded-md" />
            <Skeleton className="h-7 w-12 rounded-md" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agents panel */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-lg border border-border bg-card p-5 space-y-3">
            <Skeleton className="h-4 w-28 rounded-md" />
            <Skeleton className="h-5 w-40 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <div className="rounded-lg border border-border bg-card p-5 space-y-3">
            <Skeleton className="h-4 w-32 rounded-md" />
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-4 w-full rounded-md" />
            ))}
          </div>
        </div>

        {/* Recent activity (2-col) */}
        <div className="lg:col-span-2 space-y-4">
          {[...Array(2)].map((_, card) => (
            <div
              key={card}
              className="rounded-lg border border-border bg-card p-5 space-y-3"
            >
              <Skeleton className="h-4 w-32 rounded-md" />
              <div className="space-y-2.5">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full rounded-md" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
