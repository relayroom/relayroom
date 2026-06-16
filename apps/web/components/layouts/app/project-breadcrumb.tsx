"use client"

import { useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ChevronsUpDown, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProjectRef } from "./project-breadcrumb-context"

interface Props {
  current: ProjectRef
  projects: ProjectRef[]
}

/** Round project thumbnail (matches the circular topbar icons): image when set,
 * else a color swatch with initials. */
function Swatch({ project, className }: { project: ProjectRef; className?: string }) {
  if (project.thumbnailUrl) {
    return (
      <div className={cn("relative shrink-0 overflow-hidden rounded-full", className)}>
        <Image
          src={`/api/media/${project.thumbnailUrl.replace(/^\/+/, "")}`}
          alt={project.name}
          fill
          className="object-cover"
          unoptimized
        />
      </div>
    )
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold text-white",
        className,
      )}
      style={{ backgroundColor: project.thumbnailColor ?? "#171717" }}
    >
      {project.name.slice(0, 2).toUpperCase()}
    </div>
  )
}

export function ProjectBreadcrumb({ current, projects }: Props) {
  const t = useTranslations("project")
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // Only a switcher when there is more than one project to switch between.
  const canSwitch = projects.length > 1

  function switchTo(slug: string) {
    setOpen(false)
    if (slug !== current.slug) router.push(`/projects/${slug}`)
  }

  // < xs(480): round [DE] swatch only. xs+: [DE] + project name. lg+: also the
  // "프로젝트 /" breadcrumb prefix.
  const triggerClasses =
    "flex items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring xs:max-w-[16rem] xs:justify-start xs:gap-1.5 xs:rounded-sm xs:px-1.5 xs:py-1 xs:font-semibold xs:hover:text-accent-foreground"

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {/* Prefix - desktop only */}
      <Link
        href="/projects"
        className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground lg:block"
      >
        {t("layout.breadcrumbProjects")}
      </Link>
      <span className="hidden shrink-0 text-muted-foreground lg:block">/</span>

      {canSwitch ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={triggerClasses}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <Swatch project={current} className="h-8 w-8 xs:h-6 xs:w-6" />
            <span className="hidden truncate xs:inline">{current.name}</span>
            <ChevronsUpDown className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground xs:block" />
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute left-0 top-full z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-md bg-popover p-1 shadow-md ring-1 ring-foreground/10">
                {projects.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => switchTo(p.slug)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Swatch project={p} className="h-5 w-5 text-[9px]" />
                    <span className="flex-1 truncate text-left">{p.name}</span>
                    {p.slug === current.slug && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <Link href={`/projects/${current.slug}`} className={triggerClasses}>
          <Swatch project={current} className="h-8 w-8 xs:h-6 xs:w-6" />
          <span className="hidden truncate xs:inline">{current.name}</span>
        </Link>
      )}
    </div>
  )
}
