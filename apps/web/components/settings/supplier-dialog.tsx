"use client"

import * as React from "react"

import {
  saveSupplier,
  type SupplierSummary,
} from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"
import { cn } from "@/lib/utils"
import type { ExpenseCategoryRow } from "@/lib/backend/types"

const NAME_FIELD = "supplier-name"

/**
 * One supplier's details. The name is the only required field, because it is
 * what keys the supplier's invoices and packs; everything else is the
 * merchant's own address book. Mounted per edit, so the fields start from the
 * supplier the row named and nothing has to reset them.
 */
export function SupplierDialog({
  open,
  supplier,
  categories,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  /** Null adds a supplier. */
  supplier: SupplierSummary | null
  /** The workspace's expense categories, for the default this supplier files
   *  its lines under. */
  categories: ExpenseCategoryRow[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void | Promise<void>
}) {
  const [name, setName] = React.useState(supplier?.name ?? "")
  const [email, setEmail] = React.useState(supplier?.email ?? "")
  const [phone, setPhone] = React.useState(supplier?.phone ?? "")
  const [accountNumber, setAccountNumber] = React.useState(
    supplier?.accountNumber ?? ""
  )
  const [notes, setNotes] = React.useState(supplier?.notes ?? "")
  const [defaultCategoryId, setDefaultCategoryId] = React.useState(
    supplier?.defaultCategoryId ?? ""
  )

  const categoryLabels = React.useMemo(
    () => ({
      "": "No default category",
      ...Object.fromEntries(
        categories.map((category) => [category.id, category.name])
      ),
    }),
    [categories]
  )

  const form = useFormSave({
    snapshot: JSON.stringify([
      name,
      email,
      phone,
      accountNumber,
      notes,
      defaultCategoryId,
    ]),
    validate: (): FormErrors =>
      name.trim() ? {} : { [NAME_FIELD]: "Enter a supplier name." },
    save: async () => {
      const result = await saveSupplier({
        id: supplier?.id,
        name: name.trim(),
        email,
        phone,
        accountNumber,
        notes,
        defaultCategoryId: defaultCategoryId || null,
      })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      onOpenChange(false)
      void onSaved()
    })

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
        <DialogHeader>
          <DialogTitle>
            {supplier ? "Edit supplier" : "Add supplier"}
          </DialogTitle>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="grid gap-3">
            <LabeledInput
              label="Name"
              id={NAME_FIELD}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <LabeledInput
              label="Email"
              type="email"
              maxLength={200}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <LabeledInput
              label="Phone"
              maxLength={64}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <LabeledInput
              label="Account number"
              maxLength={64}
              value={accountNumber}
              onChange={(event) => setAccountNumber(event.target.value)}
            />
            <LabeledShell label="Default category">
              <Select
                items={categoryLabels}
                value={defaultCategoryId}
                onValueChange={(next) => setDefaultCategoryId(String(next))}
              >
                <SelectTrigger
                  aria-label="Default category"
                  className={cn(labeledControlClassName, "justify-between")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No default category</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledShell>
            <Textarea
              aria-label="Notes"
              placeholder="Notes"
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          {form.errors[NAME_FIELD] || form.failure ? (
            <p role="alert" className="text-base text-destructive">
              {form.errors[NAME_FIELD] ?? form.failure?.message}
            </p>
          ) : null}

          <DialogFooter className="mt-[18px]">
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
