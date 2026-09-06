"use client"

import * as React from "react"
import { useLinkStatus } from "next/link"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

/**
 * The segmented pill group that switches a screen's tabs (Products /
 * Modifiers / Ignored). A 32px grey track holds 28px chips; the active chip is
 * white and ink, the rest are quiet until hover. Nothing moves and nothing
 * animates — the fill just swaps.
 *
 * When a pill is a link, the fill swaps the moment it is clicked, before the
 * new page has rendered, so the screen never looks stuck on the old choice
 * while the server answers. `onPendingChange` lets the screen dim what the
 * pills switch until then.
 *
 *   <TabPills>
 *     <TabPill active={tab === "items"} render={<Link href="?tab=items" />}>
 *       Products
 *     </TabPill>
 *     …
 *   </TabPills>
 */
const PendingPill = React.createContext<{
  pendingId: string | null
  setPendingId: React.Dispatch<React.SetStateAction<string | null>>
}>({ pendingId: null, setPendingId: () => {} })

function TabPills({
  className,
  onPendingChange,
  ...props
}: React.ComponentProps<"div"> & {
  onPendingChange?: (pending: boolean) => void
}) {
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  React.useEffect(() => {
    onPendingChange?.(pendingId !== null)
  }, [pendingId, onPendingChange])
  return (
    <PendingPill.Provider value={{ pendingId, setPendingId }}>
      <div
        data-slot="tab-pills"
        className={cn(
          "flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5",
          className
        )}
        {...props}
      />
    </PendingPill.Provider>
  )
}

/** Reports this pill's in-flight navigation to the group; idle outside a link. */
function PendingWatch({ id }: { id: string }) {
  const { pending } = useLinkStatus()
  const { setPendingId } = React.useContext(PendingPill)
  React.useEffect(() => {
    if (pending) setPendingId(id)
    else setPendingId((current) => (current === id ? null : current))
  }, [pending, id, setPendingId])
  return null
}

function TabPill({
  className,
  active = false,
  render,
  children,
  ...props
}: useRender.ComponentProps<"button"> & { active?: boolean }) {
  const id = React.useId()
  const { pendingId } = React.useContext(PendingPill)
  // While a click is in flight the fill belongs to the clicked pill alone.
  const shown = pendingId ? pendingId === id : active
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type: "button",
        "aria-current": active ? "page" : undefined,
        className: cn(
          "flex h-7 items-center rounded-full border border-transparent px-3.5 text-sm leading-none font-medium whitespace-nowrap outline-none focus-visible:border-foreground",
          shown
            ? "bg-card text-foreground"
            : "text-muted-foreground hover:text-foreground",
          className
        ),
        children: (
          <>
            {children}
            <PendingWatch id={id} />
          </>
        ),
      },
      props
    ),
    render,
    state: { slot: "tab-pill", active },
  })
}

export { TabPill, TabPills }
