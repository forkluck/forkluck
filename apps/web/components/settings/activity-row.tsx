"use client"

import * as React from "react"
import Link from "next/link"
import { Archive, Pen, Plug, Plus, Trash2, Upload } from "lucide-react"

import { formatInZone } from "@/lib/datetime"
import type { ActivityEvent, ActivityEventKind } from "@/lib/backend/types"

/** One logged change, drawn the same way in the history dialog and on the
 *  invoice that the entries belong to. */

export const EVENT_ICONS: Record<ActivityEventKind, typeof Pen> = {
  added: Plus,
  edited: Pen,
  deleted: Trash2,
  archived: Archive,
  restored: Archive,
  imported: Upload,
  connected: Plug,
  disconnected: Plug,
}

const RESOURCE_LABELS: Record<ActivityEvent["resourceType"], string> = {
  recipe: "Recipe",
  ingredient: "Ingredient",
  menu: "Menu",
  invoice: "Invoice",
  category: "Category",
  import: "Import",
  settings: "Settings",
  connection: "Connection",
  workspace: "Workspace",
}

export function timestamp(createdAt: Date, timeZone: string): string {
  const day = formatInZone(createdAt, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
  const time = formatInZone(createdAt, timeZone, {
    hour: "numeric",
    minute: "2-digit",
  })
  return `${day} | ${time}`
}

export function initials(actorName: string): string {
  const letters = actorName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
  return letters.toUpperCase() || "?"
}

/** Only the two resources with a page of their own carry a link. */
function resourceHref(item: ActivityEvent): string | null {
  const publicId = item.context.publicId
  if (typeof publicId !== "string" || !publicId) return null
  if (item.resourceType === "recipe") return `/recipes/${publicId}/recipe`
  if (item.resourceType === "ingredient")
    return `/ingredients/${publicId}/ingredient`
  return null
}

/**
 * A purchase-report import says what it did to the pantry. The counts are on
 * the logged event itself, so the row draws them without a second read.
 */
function importSentence(item: ActivityEvent): React.ReactNode | null {
  if (item.resourceType !== "import" || item.context.kind !== "ingredients")
    return null
  const counts: Array<[string, unknown]> = [
    ["imported", item.context.imported],
    ["new", item.context.created],
    ["updated", item.context.updated],
  ]
  return (
    <>
      {"Imported "}
      <strong className="font-semibold">{item.name}</strong>
      {counts
        .filter(([, value]) => typeof value === "number")
        .map(([label, value]) => ` · ${value} ${label}`)
        .join("")}
    </>
  )
}

export type HistoryRow = { item: ActivityEvent; count: number }

/**
 * Six saves of the same recipe in a row are one line saying "6 times", not six
 * lines. Only a resource id proves two entries are the same thing twice.
 */
export function groupRows(items: readonly ActivityEvent[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const item of items) {
    const last = rows.at(-1)
    if (
      last &&
      item.resourceId !== null &&
      last.item.resourceId === item.resourceId &&
      last.item.event === item.event
    ) {
      last.count += 1
      continue
    }
    rows.push({ item, count: 1 })
  }
  return rows
}

/**
 * The 56px row: the actor's initials badged with the event's icon, the
 * sentence, and when it happened. `title` names the change in the caller's own
 * words — an invoice's own history says where the document came from, where
 * the dialog names the resource type. `trailing` hangs an action off the
 * row's right edge — the history's undo for the newest import.
 */
export function ActivityRow({
  item,
  count,
  timeZone,
  title,
  trailing,
}: {
  item: ActivityEvent
  count: number
  timeZone: string
  title?: React.ReactNode
  trailing?: React.ReactNode
}) {
  const Badge = EVENT_ICONS[item.event]
  const href = resourceHref(item)
  return (
    <div className="flex h-14 items-center gap-3 border-b border-muted last:border-b-0">
      <span className="relative flex size-10 flex-none items-center justify-center rounded-full bg-secondary text-sm font-medium text-muted-foreground">
        {initials(item.actorName)}
        <span className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border border-card bg-secondary-strong text-muted-foreground">
          <Badge className="size-2.5" strokeWidth={2} aria-hidden="true" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-md text-foreground">
          {title ?? importSentence(item) ?? (
            <>
              {`${RESOURCE_LABELS[item.resourceType]} ${item.event}: `}
              <strong className="font-semibold">
                {href ? (
                  <Link href={href} className="hover:underline">
                    {item.name}
                  </Link>
                ) : (
                  item.name
                )}
              </strong>
            </>
          )}
          {count > 1 ? ` ${count} times` : ""}
          {`, by ${item.actorName}`}
        </span>
        <span className="mt-[3px] block text-xs text-muted-foreground">
          {timestamp(item.createdAt, timeZone)}
        </span>
      </span>
      {trailing ? <span className="flex-none">{trailing}</span> : null}
    </div>
  )
}
