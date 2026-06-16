"use client"

import { useState } from "react"
import { AppTopbar, type AppTopbarProps } from "./topbar"
import { CommandPalette } from "./command-palette"
import { ProjectBreadcrumbProvider } from "./project-breadcrumb-context"

type AppShellClientProps = Omit<AppTopbarProps, "onCommandOpen"> & {
  children: React.ReactNode
}

/**
 * Thin client wrapper that owns the ⌘K open state and wires it between
 * AppTopbar (trigger button) and CommandPalette (the dialog).
 * AppSidebar is rendered server-side in the layout above this.
 */
export function AppShellClient({ children, ...topbarProps }: AppShellClientProps) {
  const [cmdOpen, setCmdOpen] = useState(false)

  return (
    <ProjectBreadcrumbProvider>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar {...topbarProps} onCommandOpen={() => setCmdOpen(true)} />
        <main id="main-content" className="flex-1">
          {children}
        </main>
      </div>
    </ProjectBreadcrumbProvider>
  )
}
