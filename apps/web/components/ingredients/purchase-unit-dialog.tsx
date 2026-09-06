"use client"

import * as React from "react"

import { PurchaseUnitFields } from "@/components/ingredients/purchase-unit-fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import type { SaveFailure } from "@/lib/save-failure"
import type { PurchaseUnit } from "@/components/ingredients/purchase-unit-fields"
import type { IngredientRow } from "@/lib/backend/types"

export type { PurchaseUnit } from "@/components/ingredients/purchase-unit-fields"

const UNIT_FIELD = "purchase-unit"

export function PurchaseUnitDialog({
  open,
  onOpenChange,
  initial,
  invoicePrices,
  onSave,
  allowItemSync = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: PurchaseUnit
  invoicePrices: IngredientRow["invoicePrices"]
  /** Null once the pack is written; the dialog shows any failure. */
  onSave: (unit: PurchaseUnit) => Promise<SaveFailure | null>
  allowItemSync?: boolean
}) {
  const [value, setValue] = React.useState<PurchaseUnit>(initial)
  const form = useFormSave({
    snapshot: JSON.stringify(value),
    validate: (): FormErrors =>
      value.unit ||
      value.disconnectInvoicePriceId ||
      value.useInvoicePriceId ||
      (value.invoiceLineId &&
        value.invoicePurchaseSize &&
        value.invoicePurchaseUnit)
        ? {}
        : { [UNIT_FIELD]: "Select a purchase unit." },
    save: () =>
      onSave({
        ...value,
        invoiceLineId: value.invoiceLineId ?? null,
        disconnectInvoicePriceId: value.disconnectInvoicePriceId ?? null,
        useInvoicePriceId: value.useInvoicePriceId ?? null,
      }),
  })
  const { confirm, dialog } = useDirtyDialog()

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Price</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.submit().then((done) => {
              if (done) onOpenChange(false)
            })
          }}
        >
          <PurchaseUnitFields
            value={value}
            onChange={setValue}
            invoicePrices={invoicePrices}
            allowItemSync={allowItemSync}
            autoFocus
            unitId={UNIT_FIELD}
            unitInvalid={Boolean(form.errors[UNIT_FIELD])}
          />

          {form.errors[UNIT_FIELD] || form.failure ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {form.errors[UNIT_FIELD] ?? form.failure?.message}
            </p>
          ) : null}

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" pending={form.pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
