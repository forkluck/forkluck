import * as React from "react"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Table primitives, measured off the handoff:
 *
 *   wrapper   border-top `--muted`, border-bottom `--border`  (see TableFrame)
 *   header    48px, one `--border` rule under it, 500 11.5px `--ink-soft`
 *   row       48px (52px on Labor via `className`), `--muted` rule, hover
 *             `--fill-soft`
 *   cell      primary 14.5px ink · secondary 13.5px `--muted-foreground`
 *
 * Cells carry no left padding: columns are set by their own widths and a 12px
 * right gutter, so the first cell sits flush against the frame's 2px inset and
 * the last one ends flush at the right edge. There is no outer card and no
 * shadow — the two horizontal rules are the entire frame.
 */

/**
 * The rules that close a table top and bottom, plus the 2px inset the rows sit
 * in. Put the scroll container here (`overflow-x-auto`) so the frame stays put
 * while columns move.
 */
function TableFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-frame"
      className={cn(
        "relative border-t border-b border-t-muted border-b-border bg-card px-0.5",
        className
      )}
      {...props}
    />
  )
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      // 14.5px is the handoff's primary cell size; cells that read as
      // secondary drop to 13.5px at the call site.
      className={cn(
        "w-full border-collapse text-md text-foreground",
        className
      )}
      {...props}
    />
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={className} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  // Selected rows keep their normal background — the checked box is the whole
  // selection indicator. Row rules are the lighter fill, so the header's
  // --border rule stays the strongest line in the table.
  return (
    <tr
      data-slot="table-row"
      // The last rule is dropped so the frame's own bottom border closes the
      // list — the handoff does the same thing with `margin-bottom:-1px`.
      className={cn(
        "group/row h-12 border-b border-muted last:border-b-0 hover:bg-fill-soft",
        className
      )}
      {...props}
    />
  )
}

/** The header row's own rule, so `TableHeader` can stay unstyled. */
function TableHeaderRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-header-row"
      // 48px tall over the one --border rule that separates head from body.
      className={cn("h-12 border-b border-border text-left", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "py-0 pr-3 pl-0 text-2xs leading-none font-medium whitespace-nowrap text-ink-soft last:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("py-0 pr-3 pl-0 last:pr-0", className)}
      {...props}
    />
  )
}

/** Full-width message row, for "no results" inside an otherwise valid table. */
/**
 * The "nothing here yet" row, and exactly one row tall — the same 48px a
 * filled row takes. It used to be `py-10`, around 97px, so a table doubled in
 * height while it was empty and then collapsed by half the moment the first
 * row arrived, dragging whatever sat under it upward. An empty table should
 * be the size of a table with one row in it.
 *
 * A screen that wants more air for a genuinely empty page passes its own
 * height; the default is the one that does not move.
 */
function TableEmpty({
  colSpan,
  className,
  ...props
}: React.ComponentProps<"td"> & { colSpan: number }) {
  return (
    <tr>
      <td
        data-slot="table-empty"
        colSpan={colSpan}
        className={cn(
          "h-12 px-4 text-center text-base text-muted-foreground",
          className
        )}
        {...props}
      />
    </tr>
  )
}

/**
 * The in-flight state of a server-backed table: existing rows stay put and wash
 * out, with one spinner over them. The wait belongs to the results, not to the
 * search field. Needs a `relative` container — `TableFrame` is one.
 */
function TableBusy({ label = "Searching" }: { label?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center bg-card/70 pt-[76px]">
      <Spinner size="sm" label={label} />
    </div>
  )
}

export {
  Table,
  TableBody,
  TableBusy,
  TableCell,
  TableEmpty,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
}
