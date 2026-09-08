"use client"

import * as React from "react"
import { Search } from "lucide-react"

import { searchApp } from "@/app/(app)/actions"
import { useGuardedNavigate } from "@/components/navigation-blocker"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Kbd, useShortcutLabel } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { rankedMatches, rankedServerResults } from "@/lib/search"
import type { SearchItem } from "@/components/search/search-items"

/** How many server rows show; the places to go are listed in full. */
const MAX_RESULTS = 9

/**
 * The one search surface: a centered modal off the sidebar magnifier or ⌘K.
 * It opens on the places to go, the screens the sidebar lists for this
 * reader, so "lab", Enter reaches Labor before any request has landed; the
 * server's recipes and ingredients join underneath as they arrive.
 */
export function AppSearch({ places = [] }: { places?: SearchItem[] }) {
  const { go: navigate } = useGuardedNavigate()
  const shortcut = useShortcutLabel("K")
  const listId = React.useId()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [items, setItems] = React.useState<SearchItem[]>([])
  // The query the current `items` were fetched for; null means nothing has
  // loaded yet. Comparing it to the live query says whether a refresh is
  // still on its way without a separate loading flag.
  const [fetchedFor, setFetchedFor] = React.useState<string | null>(null)

  const openSearch = React.useCallback(() => {
    // Never make a result from the previous query keyboard-selectable while
    // the new default payload is loading.
    setItems([])
    setFetchedFor(null)
    setOpen(true)
  }, [])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [openSearch])

  // Ghost-style palette: keystrokes only ever filter what is already in the
  // browser, and the server refresh lands quietly after a pause. Previous
  // results are never cleared mid-typing, so the field never stalls behind
  // an in-flight request.
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    const trimmedQuery = query.trim()
    const timeout = window.setTimeout(
      () => {
        void searchApp(trimmedQuery)
          .then((results) => {
            if (cancelled) return
            setItems(results)
          })
          .catch(() => {
            if (!cancelled) setItems([])
          })
          .finally(() => {
            if (!cancelled) setFetchedFor(trimmedQuery)
          })
      },
      trimmedQuery ? 200 : 0
    )
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [open, query])

  const trimmed = query.trim().toLowerCase()
  // Places are filtered here, since they were never searched by the server;
  // server rows are only ranked, since refining them locally could hide a
  // row the server matched on a field the browser never sees.
  const matches = React.useMemo(
    () => [
      ...rankedMatches(places, (item) => [item.label], query),
      ...rankedServerResults(items, (item) => [item.label], query).slice(
        0,
        MAX_RESULTS
      ),
    ],
    [items, places, query]
  )

  // Grouped for display, flat for keyboard: one index walks every row in the
  // order they are painted.
  const groups = React.useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, SearchItem[]>()
    for (const item of matches) {
      const bucket = byGroup.get(item.group)
      if (bucket) {
        bucket.push(item)
      } else {
        order.push(item.group)
        byGroup.set(item.group, [item])
      }
    }
    return order.map((label) => ({ label, items: byGroup.get(label) ?? [] }))
  }, [matches])
  const flat = groups.flatMap((group) => group.items)

  const resolvedActiveIndex =
    flat.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), flat.length - 1)

  const refreshing = fetchedFor !== query.trim()

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery("")
      setActiveIndex(0)
      setItems([])
      setFetchedFor(null)
    }
  }

  const go = async (href: string) => {
    if (await navigate(href)) onOpenChange(false)
  }

  let rowIndex = -1

  return (
    <>
      {/* Icon-only trigger; the field itself only exists inside the modal.
          Hovering it names the shortcut. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search Forkluck"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-sidebar-foreground hover:bg-sidebar-hover focus-visible:border-foreground focus-visible:outline-none md:size-8"
            />
          }
        >
          <Search
            className="size-[17px]"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipContent>
          Search <Kbd>{shortcut}</Kbd>
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          size="md"
          showCloseButton={false}
          // One fixed height: typing moves the rows, never the modal. Only
          // the result list scrolls.
          className="top-24 flex h-[min(480px,calc(100svh-8rem))] translate-y-0 flex-col gap-0 overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">Search Forkluck</DialogTitle>

          {/* 54px field row over a light rule; the Esc chip names the exit. */}
          <div className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-muted px-[18px]">
            <Search
              className="size-[17px] shrink-0 text-faint"
              strokeWidth={2}
              aria-hidden="true"
            />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                resolvedActiveIndex >= 0
                  ? `${listId}-option-${resolvedActiveIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-label="Search Forkluck"
              placeholder="Search Forkluck"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(event) => {
                if (flat.length === 0) return

                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setActiveIndex((index) => (index + 1) % flat.length)
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setActiveIndex((index) =>
                    index <= 0 ? flat.length - 1 : index - 1
                  )
                } else if (event.key === "Home") {
                  event.preventDefault()
                  setActiveIndex(0)
                } else if (event.key === "End") {
                  event.preventDefault()
                  setActiveIndex(flat.length - 1)
                } else if (event.key === "Enter") {
                  event.preventDefault()
                  go(flat[Math.max(resolvedActiveIndex, 0)].href)
                }
              }}
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-lg text-foreground outline-none placeholder:text-faint"
            />
            <Kbd aria-hidden="true" className="shrink-0 text-faint">
              Esc
            </Kbd>
          </div>

          <div
            id={listId}
            role="listbox"
            aria-label="Search results"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {refreshing && groups.length === 0 ? (
              <p className="px-3 py-4 text-base text-muted-foreground">
                Searching…
              </p>
            ) : groups.length > 0 ? (
              groups.map((group) => (
                <div key={group.label}>
                  <div className="px-3 pt-2 pb-1 text-2xs leading-none font-medium text-faint">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    rowIndex += 1
                    const index = rowIndex
                    return (
                      <button
                        key={`${item.group}:${item.href}:${item.label}`}
                        id={`${listId}-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === resolvedActiveIndex}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => go(item.href)}
                        className="flex h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-left hover:bg-muted aria-selected:bg-muted"
                      >
                        <span className="truncate text-md text-foreground">
                          {item.label}
                        </span>
                        {item.meta ? (
                          <span className="shrink-0 text-sm text-faint">
                            {item.meta}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))
            ) : (
              <p className="px-3 py-7 text-center text-base text-faint">
                Nothing matches that yet.
              </p>
            )}
          </div>

          <span className="sr-only" aria-live="polite">
            {trimmed
              ? flat.length === 1
                ? "1 result"
                : `${flat.length} results`
              : ""}
          </span>
        </DialogContent>
      </Dialog>
    </>
  )
}
