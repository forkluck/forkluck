import * as React from "react"
import { ChevronRight, type LucideIcon } from "lucide-react"

/**
 * The clickable row: the whole row is the target, the way the settings
 * screen's rows are. An icon lane, a title over a subdued note, and a chevron
 * where the row leads somewhere (or `trailing` where it acts in place). Rows
 * stack inside one `rounded-xl` hairline box and share a hairline between
 * them; hover takes the soft fill, focus draws the row's outline in ink.
 *
 * The row element is the caller's: a `<button>` for an action, a link for a
 * destination, both wearing `clickableRowClassName` around a
 * `ClickableRowBody`.
 */
export const clickableRowClassName =
  "flex w-full items-center gap-3 border-b border-muted px-4 py-3.5 text-left outline-none last:border-b-0 hover:bg-fill-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground"

export function ClickableRows({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {children}
    </div>
  )
}

export function ClickableRowBody({
  icon: Icon,
  title,
  note,
  trailing,
}: {
  icon: LucideIcon
  title: string
  note: string
  /** What sits where the chevron would, for a row that acts in place. */
  trailing?: React.ReactNode
}) {
  return (
    <>
      <span className="flex w-[17px] flex-none items-center justify-center text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-md text-foreground">{title}</span>
        <span className="mt-[3px] block text-md text-muted-foreground">
          {note}
        </span>
      </span>
      {trailing ?? (
        <ChevronRight
          className="size-3.5 flex-none text-disabled-foreground"
          strokeWidth={2}
          aria-hidden="true"
        />
      )}
    </>
  )
}
