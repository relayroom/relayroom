"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

export interface ProjectRef {
  slug: string
  name: string
  thumbnailColor: string | null
  thumbnailUrl: string | null
}

export interface BreadcrumbData {
  current: ProjectRef
  projects: ProjectRef[]
}

const ReadContext = createContext<BreadcrumbData | null>(null)
const SetContext = createContext<(data: BreadcrumbData | null) => void>(() => {})

/**
 * Holds the topbar-left project breadcrumb. The project layout pushes its data on
 * mount and clears it on unmount (see ProjectBreadcrumbSetter), so the breadcrumb
 * is shown only while inside a project and disappears deterministically when you
 * navigate away - no parallel-route slot retention quirks.
 */
export function ProjectBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<BreadcrumbData | null>(null)
  return (
    <SetContext.Provider value={setData}>
      <ReadContext.Provider value={data}>{children}</ReadContext.Provider>
    </SetContext.Provider>
  )
}

export const useProjectBreadcrumb = () => useContext(ReadContext)
export const useSetProjectBreadcrumb = () => useContext(SetContext)
