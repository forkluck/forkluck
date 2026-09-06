"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { Filter } from "lucide-react"

import { undoIngredientImport } from "@/app/(app)/ingredients/actions"
import {
  loadActivity,
  loadIngredientImports,
} from "@/app/(app)/settings/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { ActivityRow, groupRows } from "@/components/settings/activity-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useUndoImport } from "@/hooks/use-undo-import"
import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityResourceType,
  IngredientImportRow,
} from "@/lib/backend/types"

/**
 * What changed in the workspace, newest first. One filter covers several wire
 * values where the difference is not worth a switch: Archived also restores,
 * Connected also disconnects, Settings also covers the connection and the
 * workspace itself.
 */
const EVENT_FILTERS = [
  { key: "added", label: "Added", events: ["added"] },
  { key: "edited", label: "Edited", events: ["edited"] },
  { key: "deleted", label: "Deleted", events: ["deleted"] },
  { key: "archived", label: "Archived", events: ["archived", "restored"] },
  { key: "imported", label: "Imported", events: ["imported"] },
  {
    key: "connected",
    label: "Connected",
    events: ["connected", "disconnected"],
  },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  events: readonly ActivityEventKind[]
}>

const TYPE_FILTERS = [
  { key: "recipe", label: "Recipes", types: ["recipe"] },
  { key: "ingredient", label: "Ingredients", types: ["ingredient"] },
  { key: "menu", label: "Menus", types: ["menu"] },
  { key: "invoice", label: "Invoices", types: ["invoice"] },
  { key: "category", label: "Categories", types: ["category"] },
  { key: "import", label: "Imports", types: ["import"] },
  {
    key: "settings",
    label: "Settings",
    types: ["settings", "connection", "workspace"],
  },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  types: readonly ActivityResourceType[]
}>

function FilterColumn({
  title,
  options,
  on,
  onToggle,
}: {
  title: string
  options: ReadonlyArray<{ key: string; label: string }>
  on: readonly string[]
  onToggle: (key: string) => void
}) {
  return (
    <div>
      <p className="mb-1 text-2xs font-semibold text-muted-foreground">
        {title}
      </p>
      {options.map((option) => (
        <div
          key={option.key}
          className="flex h-8 items-center justify-between gap-3"
        >
          <span className="text-base text-foreground">{option.label}</span>
          <Switch
            size="sm"
            aria-label={option.label}
            checked={on.includes(option.key)}
            onCheckedChange={() => onToggle(option.key)}
          />
        </div>
      ))}
    </div>
  )
}

export function HistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { timezone } = useBusinessSettings()
  const [onEvents, setOnEvents] = React.useState<readonly string[]>(
    EVENT_FILTERS.map((option) => option.key)
  )
  const [onTypes, setOnTypes] = React.useState<readonly string[]>(
    TYPE_FILTERS.map((option) => option.key)
  )
  // One state for the whole page set, stamped with the filters that fetched
  // it: a load never has to clear the last one up front, so changing a filter
  // cannot flash an empty list before the answer arrives.
  const [loaded, setLoaded] = React.useState<{
    key: string
    items: ActivityEvent[]
    nextBefore: string | null
    error: string | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  // Bumped after an undo so the list re-reads: the entry has to stop offering
  // the button it just used.
  const [reloadKey, setReloadKey] = React.useState(0)
  const [imports, setImports] = React.useState<IngredientImportRow[] | null>(
    null
  )

  // Memoized so the load effect and the sentinel see a stable dependency: a
  // fresh array every render would refetch the list on every keystroke.
  const events = React.useMemo(
    () =>
      onEvents.length === EVENT_FILTERS.length
        ? undefined
        : EVENT_FILTERS.filter((option) =>
            onEvents.includes(option.key)
          ).flatMap((option) => [...option.events]),
    [onEvents]
  )
  const types = React.useMemo(
    () =>
      onTypes.length === TYPE_FILTERS.length
        ? undefined
        : TYPE_FILTERS.filter((option) => onTypes.includes(option.key)).flatMap(
            (option) => [...option.types]
          ),
    [onTypes]
  )
  const filtered = events !== undefined || types !== undefined
  const key = `${events?.join(",") ?? "*"}|${types?.join(",") ?? "*"}`
  const current = loaded?.key === key ? loaded : null

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    loadActivity({ events, types })
      .then((payload) => {
        if (cancelled) return
        setLoaded({
          key,
          items: payload.items,
          nextBefore: payload.nextBefore,
          error: null,
        })
      })
      .catch(() => {
        if (cancelled) return
        setLoaded({
          key,
          items: [],
          nextBefore: null,
          error: "Couldn’t load your history. Try again.",
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, events, types, key, reloadKey])

  const loadMore = React.useCallback(() => {
    const before = current?.nextBefore
    if (!before || loadingMore) return
    setLoadingMore(true)
    loadActivity({ before, events, types })
      .then((payload) =>
        setLoaded((previous) =>
          previous?.key === key
            ? {
                ...previous,
                items: [...previous.items, ...payload.items],
                nextBefore: payload.nextBefore,
              }
            : previous
        )
      )
      .catch(() =>
        setLoaded((previous) =>
          previous?.key === key
            ? { ...previous, error: "Couldn’t load more history. Try again." }
            : previous
        )
      )
      .finally(() => setLoadingMore(false))
  }, [current, events, key, loadingMore, types])

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

  const toggle =
    (setter: React.Dispatch<React.SetStateAction<readonly string[]>>) =>
    (key: string) =>
      setter((previous) =>
        previous.includes(key)
          ? previous.filter((current) => current !== key)
          : [...previous, key]
      )

  const error = current?.error ?? null
  const rows = current && !error ? groupRows(current.items) : null

  // Whether an import can still be undone is the import's own state, not the
  // log's, so the rows are only worth a second read once one is on screen.
  const hasIngredientsImport =
    rows?.some(
      (row) =>
        row.item.resourceType === "import" &&
        row.item.context.kind === "ingredients"
    ) ?? false
  React.useEffect(() => {
    if (!hasIngredientsImport || imports !== null) return
    let cancelled = false
    loadIngredientImports()
      .then((items) => {
        if (!cancelled) setImports(items)
      })
      .catch(() => {
        if (!cancelled) setImports([])
      })
    return () => {
      cancelled = true
    }
  }, [hasIngredientsImport, imports])
  const importById = React.useMemo(
    () => new Map((imports ?? []).map((item) => [item.id, item])),
    [imports]
  )

  const {
    armedId,
    pendingId,
    undo,
    error: undoError,
  } = useUndoImport(
    async (id: string) => {
      const result = await undoIngredientImport(id)
      setImports(null)
      setReloadKey((previous) => previous + 1)
      return result
    },
    { refresh: false }
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader className="flex-row items-center justify-between gap-3">
          <DialogTitle>History</DialogTitle>
          <Popover.Root>
            <Popover.Trigger
              render={<Button type="button" variant="outline" size="sm" />}
            >
              <Filter strokeWidth={1.8} aria-hidden="true" />
              Filter
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner align="end" sideOffset={6} className="z-50">
                <Popover.Popup className="w-[min(23rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
                  <Popover.Title className="sr-only">
                    Filter history
                  </Popover.Title>
                  <div className="grid grid-cols-2 gap-x-5">
                    <FilterColumn
                      title="Events"
                      options={EVENT_FILTERS}
                      on={onEvents}
                      onToggle={toggle(setOnEvents)}
                    />
                    <FilterColumn
                      title="Resources"
                      options={TYPE_FILTERS}
                      on={onTypes}
                      onToggle={toggle(setOnTypes)}
                    />
                  </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </DialogHeader>

        {/* Six rows of the 56px rhythm before the list starts scrolling. */}
        <div className="-mt-0.5 max-h-[336px] overflow-y-auto border-t border-muted">
          {rows === null && !error ? (
            <p className="flex h-14 items-center text-md text-faint">
              Loading history…
            </p>
          ) : null}
          {error ? (
            <p className="flex h-14 items-center text-md text-destructive">
              {error}
            </p>
          ) : null}
          {rows?.length === 0 ? (
            <p className="flex h-14 items-center text-md text-muted-foreground">
              {filtered ? "No entries match these filters." : "Nothing yet."}
            </p>
          ) : null}
          {rows?.map(({ item, count }) => {
            const importRow = item.resourceId
              ? importById.get(item.resourceId)
              : undefined
            return (
              <ActivityRow
                key={item.id}
                item={item}
                count={count}
                timeZone={timezone}
                trailing={
                  importRow?.undoneAt ? (
                    <span className="text-xs text-muted-foreground">
                      Undone
                    </span>
                  ) : importRow?.canUndo ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        armedId === importRow.id ? "destructive" : "outline"
                      }
                      disabled={pendingId !== null}
                      onClick={() => void undo(importRow.id)}
                    >
                      {pendingId === importRow.id
                        ? "Undoing…"
                        : armedId === importRow.id
                          ? "Confirm undo"
                          : "Undo"}
                    </Button>
                  ) : undefined
                }
              />
            )
          })}
          {rows?.length ? (
            <div ref={sentinel} className="py-2 text-center">
              <span className="text-xs text-muted-foreground">
                {current?.nextBefore ? "Loading more…" : "End of history"}
              </span>
            </div>
          ) : null}
        </div>
        {undoError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {undoError}
          </p>
        ) : null}

        <DialogFooter className="mt-[18px]">
          <DialogClose render={<Button type="button" variant="outline" />}>
            Done
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
