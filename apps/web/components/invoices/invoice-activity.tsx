"use client"

import * as React from "react"

import { loadActivity } from "@/app/(app)/settings/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { ActivityRow, groupRows } from "@/components/settings/activity-row"
import type { ActivityEvent } from "@/lib/backend/types"

/**
 * Where a document came from, in the words the import wrote down: a supplier
 * connector brings its own invoices in, and everything else was read from a
 * file — uploaded or fetched from the Drive folder, which the page's own
 * "Open in Drive" link already tells apart.
 */
function importTitle(item: ActivityEvent): React.ReactNode | undefined {
  if (item.event !== "added") return undefined
  if (item.context.source === "connector") return "Added by supplier import"
  const fileName = item.context.fileName
  if (typeof fileName !== "string" || !fileName) return undefined
  return `Added from ${fileName}`
}

/**
 * This invoice's own history: who typed what into it, which lines were
 * reviewed, and which prices it moved. The same rows the History dialog draws,
 * filtered to one resource, and paged by the same sentinel.
 */
export function InvoiceActivity({ resourceId }: { resourceId: string }) {
  const { timezone } = useBusinessSettings()
  const [items, setItems] = React.useState<ActivityEvent[] | null>(null)
  const [nextBefore, setNextBefore] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    loadActivity({ resourceId })
      .then((payload) => {
        if (cancelled) return
        setItems(payload.items)
        setNextBefore(payload.nextBefore)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn’t load this invoice’s activity.")
      })
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const loadMore = React.useCallback(() => {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    loadActivity({ before: nextBefore, resourceId })
      .then((payload) => {
        setItems((previous) => [...(previous ?? []), ...payload.items])
        setNextBefore(payload.nextBefore)
      })
      .catch(() => setError("Couldn’t load more activity."))
      .finally(() => setLoadingMore(false))
  }, [loadingMore, nextBefore, resourceId])

  const sentinel = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const node = sentinel.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loadMore])

  const rows = items && !error ? groupRows(items) : null

  return (
    <section className="max-w-[560px]">
      <h2 className="text-sm leading-none font-medium text-foreground">
        Activity
      </h2>
      <div className="mt-2.5 border-t border-muted">
        {rows === null && !error ? (
          <p className="flex h-14 items-center text-md text-faint">
            Loading activity…
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="flex h-14 items-center text-md text-destructive"
          >
            {error}
          </p>
        ) : null}
        {rows?.length === 0 ? (
          <p className="flex h-14 items-center text-md text-muted-foreground">
            Nothing yet.
          </p>
        ) : null}
        {rows?.map(({ item, count }) => (
          <ActivityRow
            key={item.id}
            item={item}
            count={count}
            timeZone={timezone}
            title={importTitle(item)}
          />
        ))}
        {rows?.length ? (
          <div ref={sentinel} className="py-2 text-center">
            <span className="text-xs text-muted-foreground">
              {nextBefore ? "Loading more…" : "End of activity"}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
