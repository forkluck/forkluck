"use client"

import * as React from "react"

import { Page } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * One rule for every navigation: while a page loads, the content area shows
 * the activity mark and nothing else. The shell reads `data-route-loading`
 * to hold the Primo trigger back as well, so title, tabs, content and
 * trigger all arrive together.
 *
 * A screen whose layout carries its own title and tabs (Products,
 * Integrations) keeps a loader of its own so that switching tabs inside it
 * leaves the chrome put. `SegmentLoadingProvider` in that layout tells the
 * difference between entering the screen, when the chrome is not on screen
 * yet and must wait like everything else, and switching within it.
 */
const SegmentLoadingContext = React.createContext<{
  loading: boolean
  seen: boolean
  loadingRef: React.RefObject<boolean>
  setLoading: (loading: boolean) => void
  markSeen: () => void
} | null>(null)

function SegmentLoadingProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = React.useState(false)
  const [seen, setSeen] = React.useState(false)
  const loadingRef = React.useRef(false)
  const value = React.useMemo(
    () => ({
      loading,
      seen,
      loadingRef,
      setLoading: (next: boolean) => {
        loadingRef.current = next
        setLoading(next)
      },
      markSeen: () => setSeen(true),
    }),
    [loading, seen]
  )
  return (
    <SegmentLoadingContext.Provider value={value}>
      {children}
    </SegmentLoadingContext.Provider>
  )
}

/** The layout's title and tabs: hidden until the screen has shown content once. */
function SegmentChrome({ children }: { children: React.ReactNode }) {
  const segment = React.useContext(SegmentLoadingContext)
  const loading = segment?.loading ?? false
  const markSeen = segment?.markSeen
  const loadingRef = segment?.loadingRef
  // Passive effects run after every layout effect of the commit, so by now a
  // loader mounted alongside has already raised the ref.
  React.useEffect(() => {
    if (!loadingRef?.current) markSeen?.()
  }, [loading, loadingRef, markSeen])
  if (segment && loading && !segment.seen) return null
  return children
}

/** The mark itself, centered in the viewport below the header. */
function RouteSpinner({ className }: { className?: string }) {
  return (
    <div
      data-route-loading=""
      aria-busy="true"
      className={cn(
        "grid min-h-[calc(100dvh-58px)] place-items-center",
        className
      )}
    >
      <Spinner size="lg" delayed label="Loading page" />
    </div>
  )
}

/** The app-level loader: a bare screen frame around the mark. */
function RouteLoading() {
  return (
    <Page className="py-0">
      <RouteSpinner />
    </Page>
  )
}

/**
 * A segment's own loader. Entering the screen, it is the full-height mark
 * with the chrome held back; switching tabs, it is a shorter mark under the
 * chrome that stays.
 */
function SegmentLoading() {
  const segment = React.useContext(SegmentLoadingContext)
  const setLoading = segment?.setLoading
  const entering = !(segment?.seen ?? true)
  React.useLayoutEffect(() => {
    setLoading?.(true)
    return () => setLoading?.(false)
  }, [setLoading])
  if (entering) {
    // Inside a <Page>, whose bottom padding the mark cancels so it centers
    // exactly where the app-level loader does.
    return <RouteSpinner className="-mb-8 md:-mb-[34px]" />
  }
  return (
    <div className="grid min-h-[50dvh] place-items-center" aria-busy="true">
      <Spinner size="lg" delayed label="Loading page" />
    </div>
  )
}

export { RouteLoading, SegmentChrome, SegmentLoading, SegmentLoadingProvider }
