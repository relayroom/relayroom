import { Skeleton } from "@/components/ui/skeleton"

// Fallback for any settings sub-page (profile, mail, languages, themes, team)
// while its server component streams. Mirrors the card-based settings layout.
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {[...Array(2)].map((_, card) => (
        <div key={card} className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32 rounded-md" />
            <Skeleton className="h-3 w-56 rounded-md" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[...Array(card === 0 ? 2 : 4)].map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-20 rounded-md" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      ))}
    </div>
  )
}
