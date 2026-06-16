"use client"

import { useEffect } from "react"
import {
  useSetProjectBreadcrumb,
  type ProjectRef,
} from "./project-breadcrumb-context"

/**
 * Renders nothing; pushes the current project breadcrumb into context while the
 * project layout is mounted and clears it on unmount. Lives in the project
 * layout, so it persists across sub-tabs (threads/events/...) and tears down when
 * you leave the project area.
 */
export function ProjectBreadcrumbSetter({
  current,
  projects,
}: {
  current: ProjectRef
  projects: ProjectRef[]
}) {
  const setBreadcrumb = useSetProjectBreadcrumb()

  // Re-push when the active project changes; the slug list keys project changes
  // without depending on a fresh array/object identity each render.
  const projectsKey = projects.map((p) => p.slug).join(",")

  useEffect(() => {
    setBreadcrumb({ current, projects })
    return () => setBreadcrumb(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBreadcrumb, current.slug, projectsKey])

  return null
}
