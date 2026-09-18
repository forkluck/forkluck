import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The guide's two layout helpers, and nothing else: the page shows the
 * components on the bare white page, so the only chrome a section may add is
 * an axis label.
 *
 * `Matrix` is a variant grid the way the Radix Themes playground draws one:
 * one column per variant across the top, one row per size or state down the
 * side, and the component itself in every cell. The labels are 13px ink
 * text and there are no rules or fills, so the grid reads as the components
 * arranged, not as a table of them.
 *
 * `Labeled` is the one-axis case: a component with its label under it, for a
 * row of things that vary along a single line (three spinner sizes, four
 * badge tones).
 */
export function Matrix<Column extends string, Row extends string>({
  columns,
  rows,
  cell,
  className,
}: {
  columns: readonly Column[]
  rows: readonly Row[]
  /** Renders the component for one column and row. */
  cell: (column: Column, row: Row) => React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="border-separate border-spacing-0">
        <thead>
          <tr>
            <th aria-hidden="true" className="w-0 p-0" />
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-3 pb-2 text-left align-bottom text-sm font-medium text-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th
                scope="row"
                className="py-2 pr-4 text-left align-middle text-sm font-medium whitespace-nowrap text-foreground"
              >
                {row}
              </th>
              {columns.map((column) => (
                <td key={column} className="px-3 py-2 align-middle">
                  {cell(column, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One component with its label under it, for a single-axis row. */
export function Labeled({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      {children}
      <span className="text-sm font-medium text-foreground">{label}</span>
    </div>
  )
}

/** A row of `Labeled` things, wrapping when the page is narrow. */
export function Row({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-x-8 gap-y-6", className)}>
      {children}
    </div>
  )
}
