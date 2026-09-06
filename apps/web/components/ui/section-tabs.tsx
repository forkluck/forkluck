"use client"

import * as React from "react"
import { useLinkStatus } from "next/link"

import { GuardedLink } from "@/components/navigation-blocker"
import { cn } from "@/lib/utils"

/**
 * The row of section tabs under a screen's title (Ingredient / Cost /
 * Nutrition). The chosen tab is brand blue with a blue bar on the rule; the
 * rest are quiet with a grey pill on hover. The bar moves the moment a tab is
 * clicked, before the new section has rendered, so the page never looks stuck
 * on the old one while it loads.
 */
const PendingTab = React.createContext<{
  pendingHref: string | null
  setPendingHref: React.Dispatch<React.SetStateAction<string | null>>
}>({ pendingHref: null, setPendingHref: () => {} })

function SectionTabs({
  className,
  onPendingChange,
  ...props
}: React.ComponentProps<"div"> & {
  /** Lets the screen dim the section the tabs switch until the new one lands. */
  onPendingChange?: (pending: boolean) => void
}) {
  const [pendingHref, setPendingHref] = React.useState<string | null>(null)
  React.useEffect(() => {
    onPendingChange?.(pendingHref !== null)
  }, [pendingHref, onPendingChange])
  return (
    <PendingTab.Provider value={{ pendingHref, setPendingHref }}>
      <div
        data-slot="section-tabs"
        className={cn(
          "mb-6 -ml-2.5 flex gap-1 border-b border-border print:hidden",
          className
        )}
        {...props}
      />
    </PendingTab.Provider>
  )
}

const tabClassName =
  "relative mb-2 rounded-lg px-2.5 py-1.5 text-base font-medium whitespace-nowrap outline-none"

/** Reports this link's pending navigation to the row, which moves the bar. */
function PendingWatch({ href }: { href: string }) {
  const { pending } = useLinkStatus()
  const { setPendingHref } = React.useContext(PendingTab)
  React.useEffect(() => {
    if (pending) setPendingHref(href)
    else setPendingHref((current) => (current === href ? null : current))
  }, [pending, href, setPendingHref])
  return null
}

function SectionTab({
  href,
  active,
  children,
}: {
  /** Absent on a screen whose record has not been saved yet. */
  href?: string
  active: boolean
  children: React.ReactNode
}) {
  const { pendingHref } = React.useContext(PendingTab)
  if (!href) {
    return (
      <span
        role="link"
        aria-disabled="true"
        className={cn(tabClassName, "cursor-not-allowed text-faint")}
      >
        {children}
      </span>
    )
  }
  // While a click is in flight the bar belongs to the clicked tab alone.
  const shown = pendingHref ? pendingHref === href : active
  return (
    <GuardedLink
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        tabClassName,
        shown
          ? "text-brand hover:bg-brand/10 hover:text-brand focus-visible:bg-brand/10 focus-visible:text-brand"
          : "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-2.5 -bottom-2 h-0.5",
          shown ? "bg-brand" : "bg-transparent"
        )}
      />
      <PendingWatch href={href} />
    </GuardedLink>
  )
}

export { SectionTab, SectionTabs }
