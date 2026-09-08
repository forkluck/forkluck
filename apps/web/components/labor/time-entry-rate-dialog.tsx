"use client"

import * as React from "react"

import { setTimeEntryRate } from "@/app/(app)/labor/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LabeledInput } from "@/components/ui/labeled-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"
import type { TimeEntryRow } from "@/lib/backend/types"
import { centsToDollarInput, dollarsToCents } from "@/lib/money"
import { currencySymbol, type CurrencyCode } from "@/lib/business-settings"
import { formatDateTime } from "@/lib/datetime"

const RATE_FIELD = "time-entry-hourly-rate"

export function TimeEntryRateDialog({
  entry,
  currencyCode,
  onClose,
}: {
  entry: TimeEntryRow
  currencyCode: CurrencyCode
  onClose: () => void
}) {
  const [rate, setRate] = React.useState(() =>
    entry.hourlyRateCents === null
      ? ""
      : centsToDollarInput(entry.hourlyRateCents)
  )
  const shiftLabel = formatDateTime(entry.clockIn, entry.importTimezone)

  const form = useFormSave({
    snapshot: rate,
    validate: (): FormErrors =>
      dollarsToCents(rate) === null
        ? { [RATE_FIELD]: "Enter an hourly rate, like 26.00." }
        : {},
    save: async () => {
      const result = await setTimeEntryRate({
        expectedCurrencyCode: currencyCode,
        entryId: entry.id,
        hourlyRateCents: dollarsToCents(rate)!,
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
          <DialogTitle>Edit shift rate</DialogTitle>
          <DialogDescription>
            {entry.employeeName} · {shiftLabel}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
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
            Only this shift changes. Other past and future shifts keep their
            recorded rates.
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
