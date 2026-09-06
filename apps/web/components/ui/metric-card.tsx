import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The small metric card: Analytics' second row and Labor's three headline
 * figures are the same object — 12px radius over one hairline, `18px 20px`, a
 * 500 12.5px label, a 600 26px figure, and one 12.5px sub-line.
 */
export function MetricCard({
  label,
  value,
  badge,
  note,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  value: React.ReactNode
  /** The delta pill beside the figure, when there is a baseline. */
  badge?: React.ReactNode
  note?: React.ReactNode
}) {
  return (
    <div
      data-slot="metric-card"
      className={cn(
        "rounded-xl border border-border bg-card px-5 py-[18px]",
        className
      )}
      {...props}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex min-h-[26px] items-center gap-2.5">
        <p className="min-w-0 truncate text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {value}
        </p>
        {badge}
      </div>
      {note ? (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          {note}
        </p>
      ) : null}
    </div>
  )
}

/** One inset stat inside a summary panel, as the import previews count them. */
export function Stat({
  label,
  value,
}: {
  label: React.ReactNode
  value: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 text-md font-medium tabular-nums">{value}</dd>
    </div>
  )
}
