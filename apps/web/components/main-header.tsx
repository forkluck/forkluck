"use client"

import type * as React from "react"
import { HatGlasses, Menu as MenuIcon, PanelLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { usePrimo } from "@/components/primo/primo-provider"

/**
 * The 58px bar above every screen. It carries no title, screens own their
 * own h1; it only holds the navigation toggle on small screens and the way
 * back from a collapsed sidebar. Sticky page headers below assume its height.
 */
export function MainHeader({
  navOpen,
  onOpenNav,
  sidebarCollapsed = false,
  onExpandSidebar,
  primoEnabled = false,
  primoOpen = false,
  onTogglePrimo,
  primoTriggerRef,
}: {
  navOpen: boolean
  onOpenNav: () => void
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
  primoEnabled?: boolean
  primoOpen?: boolean
  onTogglePrimo?: () => void
  primoTriggerRef?: React.Ref<HTMLButtonElement>
}) {
  const { actionLine } = usePrimo()
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-2 bg-background px-4 sm:px-6 md:h-[58px] md:px-6 print:hidden">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-controls="app-sidebar"
          aria-expanded={navOpen}
          className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-foreground focus-visible:outline-none md:hidden"
        >
          <MenuIcon
            className="size-[17px]"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>

        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={onExpandSidebar}
            aria-label="Expand sidebar"
            aria-controls="app-sidebar"
            className="-ml-1.5 hidden size-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-foreground hover:bg-muted focus-visible:border-foreground focus-visible:outline-none md:inline-flex"
          >
            <PanelLeft
              className="size-[17px]"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>

      <span
        role="status"
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-center text-sm text-muted-foreground"
      >
        {actionLine}
      </span>

      {primoEnabled ? (
        <Button
          ref={primoTriggerRef}
          type="button"
          size="icon"
          variant="ghost"
          onClick={onTogglePrimo}
          aria-label={primoOpen ? "Close Primo" : "Open Primo"}
          aria-controls="primo-rail"
          aria-expanded={primoOpen}
          title="Primo"
          // Held back while a page loads, so it arrives with the page rather
          // than ahead of it: globals.css hides it while the content column
          // holds a route loader.
          data-primo-trigger=""
        >
          <HatGlasses strokeWidth={1.8} aria-hidden="true" />
        </Button>
      ) : null}
    </header>
  )
}
