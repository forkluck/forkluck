"use client"

import * as React from "react"

import { EmployeeRateDialog } from "@/components/labor/employee-rate-dialog"
import { Button } from "@/components/ui/button"
import type { EmployeeRow } from "@/lib/backend/types"

/**
 * The Edit rate affordance on an employee's own screen. On the Labor list the
 * same dialog is opened from the row's `…` menu instead.
 */
export function EmployeeRateButton({
  employee,
  today,
  timeZone,
}: {
  employee: EmployeeRow
  /** Today in the business timezone, as `YYYY-MM-DD`. */
  today: string
  /** Timezone used by the imported shifts and backend rate lookup. */
  timeZone: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {employee.currentHourlyRateCents === null ? "Set rate" : "Edit rate"}
      </Button>
      {open ? (
        <EmployeeRateDialog
          employee={employee}
          today={today}
          timeZone={timeZone}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
