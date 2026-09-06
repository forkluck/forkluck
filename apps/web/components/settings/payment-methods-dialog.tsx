"use client"

import * as React from "react"
import { Pencil, Trash2 } from "lucide-react"

import {
  deletePaymentMethod,
  listPaymentMethods,
  savePaymentMethod,
  type PaymentMethodSummary,
} from "@/app/(app)/settings/actions"
import { AddButton } from "@/components/ui/add-button"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { InlineNameField } from "@/components/settings/inline-name-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { toSaveFailure } from "@/lib/save-failure"

/** The four every workspace has. They are wire values, so they never move. */
const BUILT_IN = ["Cash", "Card", "Bank transfer", "On account"]

/** The row being added, which has no id yet. */
const NEW_ROW = "new"

/**
 * The 470px standard modal over how invoices get paid. The four built-ins are
 * shown locked above the workspace's own methods; deleting one of those leaves
 * every invoice reading exactly what it read before, since an invoice stores
 * the method as text rather than pointing at this row.
 */
export function PaymentMethodsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [rows, setRows] = React.useState<PaymentMethodSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<PaymentMethodSummary | null>(null)
  const [pending, setPending] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const { confirm, dialog } = useDirtyDialog()
  const load = React.useCallback(
    (cancelled?: () => boolean) =>
      listPaymentMethods()
        .then((items) => {
          if (!cancelled?.()) setRows(items)
        })
        .catch(() => {
          if (!cancelled?.()) setError("Couldn’t load your payment methods.")
        }),
    []
  )

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void load(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [open, load])

  async function confirmDelete() {
    if (!deleteTarget) return
    setPending(true)
    setError(null)
    const result = await deletePaymentMethod(deleteTarget.id)
    setPending(false)
    setDeleteTarget(null)
    if ("error" in result) setError(result.error)
    else await load()
  }

  const nameField = (row: PaymentMethodSummary | null) => (
    <InlineNameField
      label={row ? `Rename ${row.name}` : "New payment method name"}
      initial={row?.name ?? ""}
      save={async (name) => {
        const result = await savePaymentMethod(
          row ? { id: row.id, name } : { name }
        )
        return "error" in result ? toSaveFailure(result) : null
      }}
      onDirtyChange={setDirty}
      onCancel={() => setEditing(null)}
      onSaved={() => {
        setEditing(null)
        void load()
      }}
    />
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) =>
        confirm(!next && dirty, () => {
          setEditing(null)
          onOpenChange(next)
        })
      }
    >
      <DialogContent>
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>Payment methods</DialogTitle>
          <AddButton
            label="Add method"
            onClick={() => {
              setError(null)
              setEditing(NEW_ROW)
            }}
          />
        </DialogHeader>

        {/* Seven rows of the 48px rhythm before the list starts scrolling. */}
        <div className="-mt-0.5 max-h-[336px] overflow-y-auto border-t border-muted">
          {editing === NEW_ROW ? (
            <div className="flex h-12 items-center gap-3 border-b border-muted">
              {nameField(null)}
            </div>
          ) : null}
          {BUILT_IN.map((name) => (
            <div
              key={name}
              className="flex h-12 items-center gap-3 border-b border-muted"
            >
              <span className="min-w-0 flex-1 truncate text-md text-muted-foreground">
                {name}
              </span>
              <span className="text-sm whitespace-nowrap text-faint">
                Built in
              </span>
            </div>
          ))}
          {rows?.map((row) => (
            <div
              key={row.id}
              className="flex h-12 items-center gap-3 border-b border-muted"
            >
              {editing === row.id ? (
                nameField(row)
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-md text-foreground">
                    {row.name}
                  </span>
                  <RowActionsMenu label={`Actions for ${row.name}`}>
                    <MenuItem onClick={() => setEditing(row.id)}>
                      <Pencil strokeWidth={1.8} aria-hidden="true" />
                      Rename
                    </MenuItem>
                    <MenuItem
                      onClick={() => setDeleteTarget(row)}
                      className="text-destructive data-highlighted:text-destructive"
                    >
                      <Trash2 strokeWidth={1.8} aria-hidden="true" />
                      Delete
                    </MenuItem>
                  </RowActionsMenu>
                </>
              )}
            </div>
          ))}
        </div>

        {error ? (
          <p role="alert" className="mt-2 text-base text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter className="mt-[18px]">
          <DialogClose render={<Button type="button" variant="outline" />}>
            Done
          </DialogClose>
        </DialogFooter>

        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null)
          }}
          title={`Delete ${deleteTarget?.name}?`}
          description="Invoices paid this way keep the method they were saved with."
          confirmLabel="Delete"
          variant="destructive"
          pending={pending}
          onConfirm={confirmDelete}
        />
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
