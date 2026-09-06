"use client"

import { FilterPill } from "@/components/ui/filter-pill"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import {
  comparisonLabel,
  comparisonPeriod,
  type Comparison,
} from "@/lib/period-comparison"

export type { Comparison }

/**
 * The `vs` pill beside the Date filter, on Analytics and on Labor.
 *
 * Each surface passes the comparisons it offers: the two differ because a
 * calendar-date step back is meaningful for sales and misleading for labor
 * (`salesComparisonOptions` / `laborComparisonOptions`). Resolving a name to
 * dates stays shared, so a comparison a surface no longer offers still reads
 * correctly if it arrives in a URL.
 */
export function ComparisonFilter({
  startDate,
  endDate,
  comparison,
  options,
  onComparisonChange,
  pending = false,
}: {
  startDate: string
  endDate: string
  comparison: Comparison
  options: Comparison[]
  onComparisonChange: (comparison: Comparison) => void
  pending?: boolean
}) {
  return (
    <FilterPill
      label="vs"
      value={comparison}
      valueLabel={formatDateRangeLabel(
        ...comparisonPeriod(startDate, endDate, comparison)
      )}
      contentClassName="w-[min(18rem,calc(100vw-2rem))]"
      options={options.map((option) => ({
        value: option,
        label: comparisonLabel(option),
      }))}
      onSelect={onComparisonChange}
      pending={pending}
    />
  )
}
