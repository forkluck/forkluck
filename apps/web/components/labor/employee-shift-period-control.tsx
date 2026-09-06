"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { DateRangeFilter } from "@/components/ui/date-range-filter"

export function EmployeeShiftPeriodControl({
  employeeId,
  startDate,
  endDate,
  timeZone,
}: {
  employeeId: string
  startDate: string
  endDate: string
  timeZone: string
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()

  return (
    <DateRangeFilter
      selectedStartDate={startDate}
      selectedEndDate={endDate}
      timeZone={timeZone}
      pending={pending}
      onSelectedDateRangeChange={(nextStart, nextEnd) => {
        const params = new URLSearchParams({ start: nextStart })
        if (nextEnd !== nextStart) params.set("end", nextEnd)
        startTransition(() =>
          router.replace(`/labor/${employeeId}?${params}`, { scroll: false })
        )
      }}
    />
  )
}
