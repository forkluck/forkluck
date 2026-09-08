"use client"

import { DateRangeFilter } from "@/components/ui/date-range-filter"
import { useBrowseUrl } from "@/hooks/use-browse-url"

export function EmployeeShiftPeriodControl({
  startDate,
  endDate,
  timeZone,
}: {
  startDate: string
  endDate: string
  timeZone: string
}) {
  // The same browse hook every filter pill uses: it writes to the page it is
  // on and carries the wait.
  const browse = useBrowseUrl({ query: "" })

  return (
    <DateRangeFilter
      selectedStartDate={startDate}
      selectedEndDate={endDate}
      timeZone={timeZone}
      pending={browse.isPending}
      onSelectedDateRangeChange={(nextStart, nextEnd) =>
        browse.setFilters({
          start: nextStart,
          end: nextEnd !== nextStart ? nextEnd : null,
          date: null,
        })
      }
    />
  )
}
