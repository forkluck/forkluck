"use client"

import * as React from "react"

import { setEmployeeRate } from "@/app/(app)/labor/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LabeledInput } from "@/components/ui/labeled-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { centsToDollarInput, dollarsToCents } from "@/lib/money"
import { toSaveFailure } from "@/lib/save-failure"
import type { EmployeeRow } from "@/lib/backend/types"
import { currencySymbol } from "@/lib/business-settings"
import { localDateKey } from "@/lib/date-presets"

const RATE_FIELD = "employee-hourly-rate"

/**
 * Edit rate — the 430px small form. One field, and one sentence naming what
 * the change does and does not touch, because a rate change that silently
 * rewrote finished labor costs would be a different feature.
 *
 * A rate the employee already has starts today, so shifts already costed keep
 * the rate they were recorded at. A first rate instead starts at their first
 * shift, so someone imported without one does not stay uncosted forever.
 *
 * Mount this with `key={employee.id}` — the field seeds itself from the row it
 * opens on and never reseeds.
 */
export function EmployeeRateDialog({
  employee,
  today,
  timeZone,
  onClose,
}: {
  employee: EmployeeRow
  /** Today in the business timezone, as `YYYY-MM-DD`. */
  today: string
  /** Timezone used by the imported shifts and backend rate lookup. */
  timeZone: string
  onClose: () => void
}) {
  const { currencyCode } = useBusinessSettings()
  const [rate, setRate] = React.useState(() =>
    employee.currentHourlyRateCents === null
      ? ""
      : centsToDollarInput(employee.currentHourlyRateCents)
  )
  const isFirstRate = employee.currentHourlyRateCents === null
  const effectiveFrom =
    isFirstRate && employee.firstShiftAt
      ? localDateKey(timeZone, employee.firstShiftAt)
      : today

  const form = useFormSave({
    snapshot: rate,
    validate: (): FormErrors =>
      dollarsToCents(rate) === null
        ? { [RATE_FIELD]: "Enter an hourly rate, like 26.00." }
        : {},
    save: async () => {
      const result = await setEmployeeRate({
        expectedCurrencyCode: currencyCode,
        employeeId: employee.id,
        hourlyRateCents: dollarsToCents(rate)!,
        effectiveFrom,
      })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then((done) => {
      if (done) onClose()
    })

  const dismiss = () => confirm(form.dirty, onClose)

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss())}>
      <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
        <DialogHeader>
          <DialogTitle className="truncate">{employee.name}</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {/* Currency and basis ride in the label; the value is a number. */}
          <LabeledInput
            label={`Hourly rate (${currencySymbol(currencyCode)} / hour)`}
            id={RATE_FIELD}
            inputMode="decimal"
            autoFocus
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            className="tabular-nums"
          />
          <p className="mt-2 text-xs leading-[1.55] text-muted-foreground">
            {isFirstRate
              ? "Applies to every shift on record. Later changes only affect shifts from the day they are made."
              : "Applies to shifts from today onward. Past labor costs keep the rate they were recorded at."}
          </p>
          {form.errors[RATE_FIELD] || form.failure ? (
            <p
              className="mt-2 text-xs leading-[1.55] text-destructive"
              role="alert"
            >
              {form.errors[RATE_FIELD] ?? form.failure?.message}
            </p>
          ) : null}

          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending}>
              Save
            </Button>
          </div>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
