"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { ComparisonFilter, type Comparison } from "@/components/period-filter"
import { DateRangeFilter } from "@/components/ui/date-range-filter"
import { laborComparisonOptions } from "@/lib/period-comparison"

/**
 * The two pills that own the Labor period: `Date 3 Aug – 9 Aug` and its
 * comparison. Both are the app's shared filter pills — Analytics runs the same
 * pair — and both write straight to the URL, so the view is shareable and
 * survives a reload.
 *
 * The comparisons offered here are not Analytics'. Labor's are every one
 * weekday-aligned, because hours follow day-of-week patterns: a Mon–Tue range
 * measured against the calendar-previous two days is measured against a
 * weekend, and the swing that reports is the shift, not the staffing.
 *
 * Rendered as a fragment: the toolbar around it supplies the 8px rhythm.
 */
export function LaborPeriodControls({
  startDate,
  endDate,
  comparison,
  timeZone,
  onPendingChange,
}: {
  startDate: string
  endDate: string
  comparison: Comparison
  timeZone: string
  /** Reports the navigation in flight, so the table below can dim. */
  onPendingChange?: (pending: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  React.useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])

  function updatePeriod(nextStart: string, nextEnd: string, next: Comparison) {
    const params = new URLSearchParams({ start: nextStart })
    if (nextEnd !== nextStart) params.set("end", nextEnd)
    // Labor's default comparison is the matching weekday a year back, so that
    // is the one left out of the URL; writing it would only add noise.
    if (next !== "fifty_two_weeks_prior") params.set("comparison", next)
    startTransition(() => router.replace(`/labor?${params}`, { scroll: false }))
  }

  return (
    <>
      <DateRangeFilter
        selectedStartDate={startDate}
        selectedEndDate={endDate}
        timeZone={timeZone}
        pending={pending}
        onSelectedDateRangeChange={(nextStart, nextEnd) =>
          updatePeriod(nextStart, nextEnd, comparison)
        }
      />
      <ComparisonFilter
        startDate={startDate}
        endDate={endDate}
        comparison={comparison}
        options={laborComparisonOptions}
        pending={pending}
        onComparisonChange={(next) => updatePeriod(startDate, endDate, next)}
      />
    </>
  )
}
