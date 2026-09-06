import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The Analytics card kit. Every card on this screen is the same object: a 12px
 * radius over one 1px --border hairline, no shadow, never nested. The one
 * table in the design whose rules do not bleed to the edge lives here too —
 * `ListCard` insets them by the card's own 20px padding.
 */

export function AnalyticsCard({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-xl border border-border bg-card", className)}
      {...props}
    />
  )
}

/** 500 12.5px --muted-foreground: the label over every metric on the screen. */
export function CardLabel({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

/** 600 26px: the figure on every card that is not the 42px hero. */
export function CardMetric({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums",
        className
      )}
      {...props}
    />
  )
}

/** The line that qualifies a metric: 400 12.5px --muted-foreground. */
export function CardNote({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-xs text-muted-foreground tabular-nums", className)}
      {...props}
    />
  )
}

/** 10px rail: --muted track, brand fill, clamped so it can never overrun. */
export function ProgressRail({
  ratio,
  label,
}: {
  ratio: number
  label?: string
}) {
  const clamped = Math.max(0, Math.min(1, ratio))
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label={label}
      className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full rounded-full bg-brand"
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  )
}

/** Top products and Price moves: a 600 14px header over an inset list. */
export function ListCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <AnalyticsCard className="overflow-hidden">
      <div className="px-5 pt-4 pb-3">
        <h2 className="text-md leading-[1.2] font-semibold">{title}</h2>
      </div>
      {children}
    </AnalyticsCard>
  )
}

/** The column rule, inset by the card padding rather than bled to the edge. */
export function ListHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-5 border-b border-border pb-1.5 text-2xs font-medium text-ink-soft",
        className
      )}
      {...props}
    />
  )
}

export function ListBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-5", className)} {...props} />
}

/** 44px row over a --muted rule; the card's own edge closes the last one. */
export const listRowClassName = "h-11 items-center border-b border-muted"

/** A column label under the design's 11px sort chevron pair. */
export function ColumnLabel({
  align = "start",
  className,
  children,
}: {
  align?: "start" | "end"
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-[5px]",
        align === "end" && "justify-end",
        className
      )}
    >
      {children}
      <ChevronsUpDown
        className="size-[11px] text-disabled-foreground"
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  )
}

/** What a list card says instead of rows when it has nothing to list. */
export function ListCardEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 pb-6 text-base leading-[1.65] text-muted-foreground">
      {children}
    </p>
  )
}
