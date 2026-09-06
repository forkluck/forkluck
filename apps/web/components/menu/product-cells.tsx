"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  TriangleAlert,
} from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The pieces the three Products tables share. Every table on this screen is a
 * CSS grid rather than a `<table>`: the handoff pins each column to an exact
 * width and the alert / badge / channel slots are columns with no header
 * label, which a column-model table cannot express.
 *
 * Header and rows always carry the *same* grid template string, so the two
 * stay locked together — change one and you must change the other.
 */

export type SortDirection = "asc" | "desc"
export type SortState<K extends string> = { key: K; direction: SortDirection }

export function useSortState<K extends string>(
  initial: SortState<K> | null = null
) {
  const [sort, setSort] = React.useState<SortState<K> | null>(initial)
  const toggle = React.useCallback((key: K) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" }
    )
  }, [])
  const directionFor = React.useCallback(
    (key: K): SortDirection | null =>
      sort?.key === key ? sort.direction : null,
    [sort]
  )
  return { sort, toggle, directionFor }
}

/** Sorts a copy; strings compare naturally so `BK-2` lands before `BK-10`. */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K> | null,
  accessors: Record<K, (row: T) => string | number>
): T[] {
  if (!sort) return rows
  const read = accessors[sort.key]
  const sorted = [...rows].sort((left, right) => {
    const a = read(left)
    const b = read(right)
    if (typeof a === "number" && typeof b === "number") return a - b
    return String(a).localeCompare(String(b), undefined, { numeric: true })
  })
  return sort.direction === "desc" ? sorted.reverse() : sorted
}

/**
 * A column label with its 11px sort chevron 5px to the right. At rest the
 * chevron is the up/down pair one step above the hairline; sorting collapses
 * it to the direction in play without moving the label.
 */
export function SortHeader({
  children,
  direction,
  align = "left",
  onClick,
}: {
  children: React.ReactNode
  direction: SortDirection | null
  align?: "left" | "right"
  onClick: () => void
}) {
  return (
    <span
      className={cn("flex items-center", align === "right" && "justify-end")}
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-[5px] rounded-md border border-transparent outline-none focus-visible:border-foreground"
      >
        {children}
        {direction === "asc" ? (
          <ChevronUp
            className="size-[11px] flex-none text-ink-soft"
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : direction === "desc" ? (
          <ChevronDown
            className="size-[11px] flex-none text-ink-soft"
            strokeWidth={2}
            aria-hidden="true"
          />
        ) : (
          <ChevronsUpDown
            className="size-[11px] flex-none text-disabled-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
        )}
      </button>
    </span>
  )
}

/** A header cell with no label — the badge, alert, and action slots. */
export function BlankHeader() {
  return <span />
}

/**
 * The row-level "needs attention" affordance: a yellow triangle in a 30px hit
 * area that opens a one-line popover naming the problem. The disclosure
 * chevron is absolutely positioned inside the reserved 21px, so it can appear
 * on row hover without moving the triangle.
 */
export function AlertFlag({
  label,
  width = 150,
  actions,
}: {
  /** One line per problem; a row can fail more than one check at a time. */
  label: string | string[]
  /** The popover's fixed width, straight off the handoff. */
  width?: number
  actions?: { label: string; onClick: () => void }[]
}) {
  const labels = Array.isArray(label) ? label : [label]
  const fixes = actions?.filter(Boolean) ?? []
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={labels.join(", ")}
        className="group/flag relative flex h-[30px] items-center rounded-lg border border-transparent pr-[21px] pl-1.5 text-warning outline-none hover:bg-warning-hover focus-visible:border-foreground data-popup-open:bg-warning-hover"
      >
        <TriangleAlert
          className="size-4 flex-none"
          strokeWidth={1.9}
          aria-hidden="true"
        />
        <ChevronDown
          className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-data-popup-open/flag:opacity-100"
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={0}
          className="z-50"
        >
          <Popover.Popup
            style={{ width }}
            className={cn(
              "rounded-lg border border-popover-border bg-popover px-3 text-md leading-5 text-warning-foreground outline-none",
              fixes.length || labels.length > 1
                ? "flex flex-col gap-1.5 py-2.5"
                : "flex h-[46px] items-center gap-2.5"
            )}
          >
            {labels.map((line) => (
              <span key={line} className="flex items-center gap-2.5">
                <TriangleAlert
                  className="size-[17px] flex-none text-warning"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {line}
              </span>
            ))}
            {fixes.map((fix) => (
              <button
                key={fix.label}
                type="button"
                onClick={fix.onClick}
                className="self-start rounded-md border border-transparent text-sm text-primary underline-offset-4 hover:underline focus-visible:border-foreground focus-visible:outline-none"
              >
                {fix.label}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * A count that opens a popover listing what it counts. The chevron appears on
 * row hover *inside* the cell's reserved 21px, so the number never shifts;
 * the count carries the hover fill, the chevron does not. Zero is a dash.
 */
export function CountCell({
  count,
  label,
  width = 220,
  children,
}: {
  count: number
  /** What is being counted, singular and plural, for the accessible name. */
  label: [string, string]
  width?: number
  /** The popover's rows. */
  children: React.ReactNode
}) {
  if (count === 0) {
    return <span className="text-base text-muted-foreground">—</span>
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${count} ${label[count === 1 ? 0 : 1]}`}
        className="group/count relative -ml-2 flex h-[30px] items-center rounded-lg border border-transparent pr-[21px] pl-2 text-base text-muted-foreground tabular-nums outline-none hover:bg-muted focus-visible:border-foreground data-popup-open:bg-muted"
        onClick={(event) => event.stopPropagation()}
      >
        {count}
        <ChevronDown
          className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-data-popup-open/count:opacity-100"
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={-2}
          className="z-50"
        >
          <Popover.Popup
            style={{ width }}
            className="flex flex-col rounded-lg border border-popover-border bg-popover p-1.5 outline-none"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A sales channel's mark, 16px, beside its name. */
export function ChannelIcon({ channel }: { channel: "square" | "shopify" }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/channel-${channel}.png`}
      alt=""
      width={16}
      height={16}
      className="size-4 shrink-0"
    />
  )
}

/** One line inside a CountCell popover: a name, and a quiet detail after it. */
export function CountRow({
  children,
  detail,
}: {
  children: React.ReactNode
  detail?: React.ReactNode
}) {
  return (
    <span className="flex h-8 items-center gap-2 px-2.5 text-base text-foreground">
      <span className="flex min-w-0 items-center gap-2 truncate">
        {children}
      </span>
      {detail ? (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {detail}
        </span>
      ) : null}
    </span>
  )
}

export type SkuEntry = {
  sku: string
  label: string
  detail: string
  multiplier: number
}

/**
 * One SKU prints plainly. More than one prints the first with a `+n` and a
 * chevron on row hover; the popover names what each SKU actually is, since a
 * bare number does not say which variant or box it belongs to.
 */
export function SkuCell({ entries }: { entries: SkuEntry[] }) {
  if (entries.length === 0) {
    return <span className="text-base text-muted-foreground">—</span>
  }

  if (entries.length === 1) {
    return (
      <span className="truncate text-base text-muted-foreground tabular-nums">
        {entries[0].sku}
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center">
      <Popover.Root>
        <Popover.Trigger
          aria-label={`${entries.length} SKUs`}
          className="group/sku relative -ml-1 flex h-[30px] min-w-0 items-center gap-1 rounded-lg border border-transparent pr-[21px] pl-1 text-base text-muted-foreground tabular-nums outline-none hover:bg-muted focus-visible:border-foreground data-popup-open:bg-muted"
        >
          <span className="truncate">{entries[0].sku}</span>
          <span className="flex-none">+{entries.length - 1}</span>
          <ChevronDown
            className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-data-popup-open/sku:opacity-100"
            strokeWidth={2.2}
            aria-hidden="true"
          />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="start"
            sideOffset={-2}
            className="z-50"
          >
            <Popover.Popup className="flex w-[264px] flex-col rounded-lg border border-popover-border bg-popover p-1.5 outline-none">
              {entries.map((entry) => (
                <span key={entry.sku} className="flex flex-col px-2.5 py-1.5">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-base text-foreground">
                      {entry.label}
                    </span>
                    <span className="flex-none text-base text-muted-foreground tabular-nums">
                      {entry.sku}
                    </span>
                  </span>
                  <span className="mt-0.5 text-xs text-faint">
                    {entry.detail}
                    {entry.multiplier === 1 ? "" : ` · ×${entry.multiplier}`}
                  </span>
                </span>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  )
}

/** The "no rows" line inside an otherwise valid table frame. */
export function TableEmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-10 text-center text-base text-muted-foreground">
      {children}
    </p>
  )
}
