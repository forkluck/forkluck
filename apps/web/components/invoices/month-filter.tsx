"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Popover } from "@base-ui/react/popover"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { monthFormat } from "@/components/ui/month-grid"
import { cn } from "@/lib/utils"

const shortMonthFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
})

/** A month key (`YYYY-MM`) as the UTC first of that month. */
function monthDate(month: string) {
  return new Date(`${month}-01T00:00:00Z`)
}

function monthKey(year: number, index: number) {
  return `${year}-${String(index + 1).padStart(2, "0")}`
}

/**
 * The Invoices month pill: the same popover shell and quiet-label pill as the
 * reporting-period picker on Analytics, month-first because the backend scopes
 * the whole screen to one month.
 *
 * Every row on screen belongs to the month in the URL, so picking one
 * navigates rather than filtering; `/invoices` with no parameter is the newest
 * month, which is what the footer row goes back to.
 */
export function InvoiceMonthFilter({
  month,
  months,
  className,
  onPendingChange,
}: {
  /** The month the overview was built for, `YYYY-MM`. */
  month: string
  /** Every month with invoices, newest first. */
  months: Array<{ month: string }>
  className?: string
  /** Reports the navigation in flight, so the table can show the wait. */
  onPendingChange?: (pending: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  React.useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])
  const [open, setOpen] = React.useState(false)
  const selectedYear = Number(month.slice(0, 4))
  const [year, setYear] = React.useState(selectedYear)
  const available = React.useMemo(
    () => new Set(months.map((entry) => entry.month)),
    [months]
  )
  const newestMonth = months[0]?.month
  const earliestMonth = months[months.length - 1]?.month
  const atNewest = month === newestMonth

  const choose = (next: string | null) => {
    setOpen(false)
    // The newest month is what `/invoices` already renders, so it keeps the
    // bare path rather than pinning a parameter that would go stale.
    startTransition(() =>
      router.push(
        !next || next === newestMonth ? "/invoices" : `/invoices?month=${next}`
      )
    )
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        // Reopening after browsing another year starts back on the selection.
        if (nextOpen) setYear(selectedYear)
      }}
    >
      {/* The toolbar filter pill: quiet label, ink value, no chevron. */}
      <Popover.Trigger
        render={
          <Button
            variant="filter"
            className={cn("shrink-0 gap-1.5", className)}
            pending={pending}
            aria-label={`Month: ${monthFormat.format(monthDate(month))}`}
          />
        }
      >
        Month
        <span className="font-medium text-foreground">
          {monthFormat.format(monthDate(month))}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="w-[17rem] origin-(--transform-origin) rounded-lg border border-popover-border bg-popover p-3 text-popover-foreground outline-none">
            <Popover.Title className="sr-only">Choose a month</Popover.Title>
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Previous year"
                disabled={
                  !earliestMonth || Number(earliestMonth.slice(0, 4)) >= year
                }
                onClick={() => setYear((current) => current - 1)}
              >
                <ChevronLeft />
              </Button>
              <p className="text-md font-semibold">{year}</p>
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label="Next year"
                disabled={
                  !newestMonth || Number(newestMonth.slice(0, 4)) <= year
                }
                onClick={() => setYear((current) => current + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1">
              {Array.from({ length: 12 }, (_, index) => {
                const key = monthKey(year, index)
                const selected = key === month
                return (
                  <button
                    key={key}
                    type="button"
                    // A month with no invoices has nothing to navigate to.
                    disabled={!available.has(key)}
                    aria-label={monthFormat.format(monthDate(key))}
                    aria-pressed={selected}
                    onClick={() => choose(key)}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-lg border border-transparent text-md leading-5 font-medium outline-none focus-visible:border-foreground disabled:cursor-not-allowed disabled:text-disabled-foreground",
                      selected
                        ? "bg-foreground text-background"
                        : "enabled:hover:bg-muted"
                    )}
                  >
                    {shortMonthFormat.format(monthDate(key))}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 border-t border-popover-border pt-2">
              <Button
                variant="quiet"
                className={cn(
                  "w-full justify-start",
                  atNewest && "bg-muted text-foreground"
                )}
                aria-pressed={atNewest}
                onClick={() => choose(null)}
              >
                Most recent month
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
