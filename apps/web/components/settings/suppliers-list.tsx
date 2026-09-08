"use client"

import * as React from "react"
import { Merge, Pencil, Trash2 } from "lucide-react"

import { listExpenseCategories } from "@/app/(app)/invoices/actions"
import {
  deleteSupplier,
  listSuppliers,
  mergeSuppliers,
  type SupplierSummary,
} from "@/app/(app)/settings/actions"
import { SupplierDialog } from "@/components/settings/supplier-dialog"
import { AddButton } from "@/components/ui/add-button"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  useDialogTarget,
} from "@/components/ui/dialog"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { toSaveFailure } from "@/lib/save-failure"
import type { ExpenseCategoryRow } from "@/lib/backend/types"

const MERGE_FIELD = "merge-into"

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The workspace's suppliers. Rows keep a 48px rhythm over the pale rule; the
 * count is the supplier's invoices, tabular so the column lines up.
 *
 * A supplier's name keys its invoices, packs and skip-list rows, so the two
 * edits that move rows are separate: renaming re-points them, and merging
 * folds one supplier's rows into another's.
 */
export function SuppliersList() {
  const [rows, setRows] = React.useState<SupplierSummary[] | null>(null)
  const [categories, setCategories] = React.useState<ExpenseCategoryRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<SupplierSummary | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const editorShown = useDialogTarget(editorOpen ? true : null)
  const [mergeSource, setMergeSource] = React.useState<SupplierSummary | null>(
    null
  )
  const heldMerge = useDialogTarget(mergeSource)
  const [deleteTarget, setDeleteTarget] =
    React.useState<SupplierSummary | null>(null)
  const [pending, setPending] = React.useState(false)

  const load = React.useCallback(
    (cancelled?: () => boolean) =>
      listSuppliers()
        .then((items) => {
          if (!cancelled?.()) setRows(items)
        })
        .catch(() => {
          if (!cancelled?.()) {
            setError("Couldn’t load your suppliers. Try again.")
          }
        }),
    []
  )

  React.useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    // The default category is picked from the same list the invoice screens
    // file lines under, so it is read the same way.
    void listExpenseCategories()
      .then((items) => {
        if (!cancelled) setCategories(items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [load])

  function edit(supplier: SupplierSummary | null) {
    setError(null)
    setEditing(supplier)
    setEditorOpen(true)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setPending(true)
    setError(null)
    const result = await deleteSupplier(deleteTarget.id)
    setPending(false)
    setDeleteTarget(null)
    if ("error" in result) setError(result.error)
    else await load()
  }

  return (
    <div className="max-w-[760px]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <p className="text-base text-muted-foreground">
          Who you buy from. An invoice, a pack and a skip-list row all point at
          a supplier by name.
        </p>
        <AddButton label="Add supplier" onClick={() => edit(null)} />
      </div>

      <div className="mt-2.5 border-t border-muted">
        {rows === null && !error ? (
          <p className="flex h-12 items-center text-md text-faint">
            Loading suppliers…
          </p>
        ) : null}
        {rows?.length === 0 ? (
          <p className="py-4 text-base leading-[1.6] text-muted-foreground">
            No suppliers yet. Add one, or import an invoice or a supplier price
            list.
          </p>
        ) : null}
        {rows?.map((row) => (
          <div
            key={row.id}
            className="flex h-12 items-center gap-3 border-b border-muted"
          >
            <span className="min-w-0 flex-1 truncate text-md text-foreground">
              {row.name}
            </span>
            {/* What this supplier's unremembered lines are filed under. */}
            <span className="hidden truncate text-sm text-muted-foreground sm:block">
              {categories.find(
                (category) => category.id === row.defaultCategoryId
              )?.name ?? ""}
            </span>
            <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
              {plural(row.invoiceCount, "invoice", "invoices")}
            </span>
            <RowActionsMenu label={`Actions for ${row.name}`}>
              <MenuItem onClick={() => edit(row)}>
                <Pencil strokeWidth={1.8} aria-hidden="true" />
                Edit
              </MenuItem>
              <MenuItem
                disabled={rows.length < 2}
                onClick={() => {
                  setError(null)
                  setMergeSource(row)
                }}
              >
                <Merge strokeWidth={1.8} aria-hidden="true" />
                Merge into…
              </MenuItem>
              {/* Deleting a supplier with rows would strand them under a key
                  nothing names, so the backend refuses and so does this. */}
              <MenuItem
                disabled={row.invoiceCount > 0 || row.itemCount > 0}
                onClick={() => setDeleteTarget(row)}
                className="text-destructive data-highlighted:text-destructive data-disabled:text-disabled-foreground"
              >
                <Trash2 strokeWidth={1.8} aria-hidden="true" />
                Delete
              </MenuItem>
            </RowActionsMenu>
          </div>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-base text-destructive">
          {error}
        </p>
      ) : null}

      {/* Mounted per edit, so the form starts from the row it opened on. */}
      {editorShown ? (
        <SupplierDialog
          open={editorOpen}
          supplier={editing}
          categories={categories}
          onOpenChange={setEditorOpen}
          onSaved={load}
        />
      ) : null}

      {/* Mounted per merge, so the picker starts empty every time. */}
      {heldMerge ? (
        <MergeSupplierDialog
          open={mergeSource !== null}
          source={heldMerge}
          rows={rows ?? []}
          onClose={() => setMergeSource(null)}
          onMerged={load}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
        title={`Delete ${deleteTarget?.name}?`}
        description="It has no invoices or items."
        confirmLabel="Delete"
        pending={pending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/**
 * Merging deletes a supplier and moves its rows, so it names both halves of
 * the trade before it will do anything.
 */
function MergeSupplierDialog({
  open,
  source,
  rows,
  onClose,
  onMerged,
}: {
  open: boolean
  source: SupplierSummary
  rows: SupplierSummary[]
  onClose: () => void
  onMerged: () => void | Promise<void>
}) {
  const [targetId, setTargetId] = React.useState("")
  const target = rows.find((row) => row.id === targetId) ?? null

  const form = useFormSave({
    snapshot: targetId,
    validate: (): FormErrors =>
      target ? {} : { [MERGE_FIELD]: "Pick the supplier to keep." },
    save: async () => {
      const result = await mergeSuppliers(source.id, target!.id)
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const submit = () =>
    void form.submit().then((done) => {
      if (!done) return
      onClose()
      void onMerged()
    })

  const dismiss = () => confirm(form.dirty, onClose)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <DialogContent
        onKeyDown={dialogSaveShortcut(submit)}
        showCloseButton={false}
        className="gap-0"
      >
        <DialogTitle>Merge {source.name}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="mt-3">
            <Select
              value={targetId}
              onValueChange={(next) => setTargetId(String(next))}
            >
              <SelectTrigger
                id={MERGE_FIELD}
                className="w-full"
                aria-label="Merge into"
              >
                <SelectValue>{target?.name ?? "Pick a supplier"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {rows
                  .filter((row) => row.id !== source.id)
                  .map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogDescription className="mt-3">
            {target
              ? `${plural(source.invoiceCount, "invoice", "invoices")}, ${plural(source.itemCount, "item", "items")} and ${plural(source.ignoreCount, "ignored item", "ignored items")} move to ${target.name}. ${source.name} is removed.`
              : "Pick the supplier to keep."}
          </DialogDescription>
          {form.errors[MERGE_FIELD] || form.failure ? (
            <p role="alert" className="mt-3 text-base text-destructive">
              {form.errors[MERGE_FIELD] ?? form.failure?.message}
            </p>
          ) : null}
          <div className="mt-5 flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={dismiss}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" pending={form.pending}>
              Merge
            </Button>
          </div>
        </form>
        {dialog}
      </DialogContent>
    </Dialog>
  )
}
