"use client"

import * as React from "react"
import { Pencil, Trash2 } from "lucide-react"

import { listExpenseCategories } from "@/app/(app)/invoices/actions"
import {
  deleteCategory,
  deleteExpenseCategory,
  listCategories,
  renameCategory,
  saveExpenseCategory,
  type CategoryKind,
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
import { MenuCheckItem, MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { Spinner } from "@/components/ui/spinner"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import { InlineNameField } from "@/components/settings/inline-name-field"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { toSaveFailure } from "@/lib/save-failure"

/** Expenses is the invoice vocabulary; the other two are keyed by name. */
type Tab = CategoryKind | "expense"

type Row = {
  id: string
  name: string
  /** What the category holds. Expense categories carry no count. */
  count: number | null
  /** The Ingredients row: deleting it would strand the costing pipeline. */
  locked: boolean
  /** Buys what the kitchen doesn't eat, so its lines price supplies. Always
   *  false outside the expense tab, which has no such notion. */
  supply: boolean
}

const NOUN: Record<CategoryKind, [string, string]> = {
  recipe: ["recipe", "recipes"],
  ingredient: ["ingredient", "ingredients"],
}

/** The row being added, which has no id yet. */
const NEW_ROW = "new"

function deleteNote(tab: Tab, row: Row) {
  if (tab === "expense") {
    return "Lines keep their spend; they just lose the label."
  }
  if (row.count === 0) return "Nothing uses it."
  const [one, many] = NOUN[tab]
  return `${row.count} ${row.count === 1 ? one : many} will be uncategorized.`
}

/**
 * The 470px standard modal over all three category vocabularies, one tab each.
 * Rows keep the 48px rhythm; the count is what the category holds, tabular so
 * the column lines up. Renaming happens in place, and a rename onto a name
 * that already exists merges the two on the backend.
 */
export function CategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tab, setTab] = React.useState<Tab>("recipe")
  const [rows, setRows] = React.useState<Row[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<Row | null>(null)
  const [pending, setPending] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const { confirm, dialog } = useDirtyDialog()

  const load = React.useCallback(
    (next: Tab, cancelled?: () => boolean) =>
      (next === "expense"
        ? listExpenseCategories().then((items) =>
            items.map((item) => ({
              id: item.id,
              name: item.name,
              count: null,
              // The food Ingredients row: a supply category is deletable.
              locked: item.isIngredient && !item.isSupply,
              supply: item.isSupply,
            }))
          )
        : listCategories(next).then((items) =>
            items.map((item) => ({ ...item, locked: false, supply: false }))
          )
      )
        .then((items: Row[]) => {
          if (!cancelled?.()) setRows(items)
        })
        .catch(() => {
          if (!cancelled?.()) setError("Couldn’t load your categories.")
        }),
    []
  )

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    void load(tab, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [open, tab, load])

  function switchTo(next: Tab) {
    confirm(dirty, () => {
      setTab(next)
      setRows(null)
      setError(null)
      setEditing(null)
    })
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setPending(true)
    setError(null)
    const result =
      tab === "expense"
        ? await deleteExpenseCategory(deleteTarget.id)
        : await deleteCategory(tab, deleteTarget.name)
    setPending(false)
    setDeleteTarget(null)
    if ("error" in result) setError(result.error)
    else await load(tab)
  }

  /** A supply category costs its lines like food, and what they create is a
   *  supply rather than an ingredient. */
  // The row whose toggle is in flight; the menu closed, so the row itself
  // shows the wait.
  const [busyRow, setBusyRow] = React.useState<string | null>(null)
  async function toggleSupply(row: Row) {
    setError(null)
    setBusyRow(row.id)
    try {
      const result = await saveExpenseCategory({
        id: row.id,
        name: row.name,
        isSupply: !row.supply,
      })
      if ("error" in result) setError(result.error)
      else await load(tab)
    } finally {
      setBusyRow(null)
    }
  }

  const nameField = (row: Row | null) => (
    <InlineNameField
      label={row ? `Rename ${row.name}` : "New category name"}
      initial={row?.name ?? ""}
      save={async (name) => {
        const result =
          tab === "expense"
            ? await saveExpenseCategory(row ? { id: row.id, name } : { name })
            : await renameCategory(tab, row!.name, name)
        return "error" in result ? toSaveFailure(result) : null
      }}
      onDirtyChange={setDirty}
      onCancel={() => setEditing(null)}
      onSaved={() => {
        setEditing(null)
        void load(tab)
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
          <DialogTitle>Categories</DialogTitle>
          {tab === "expense" ? (
            <AddButton
              label="Add category"
              onClick={() => {
                setError(null)
                setEditing(NEW_ROW)
              }}
            />
          ) : null}
        </DialogHeader>

        <TabPills className="mb-3 w-fit">
          <TabPill active={tab === "recipe"} onClick={() => switchTo("recipe")}>
            Recipes
          </TabPill>
          <TabPill
            active={tab === "ingredient"}
            onClick={() => switchTo("ingredient")}
          >
            Ingredients
          </TabPill>
          <TabPill
            active={tab === "expense"}
            onClick={() => switchTo("expense")}
          >
            Expenses
          </TabPill>
        </TabPills>

        {/* Seven rows of the 48px rhythm before the list starts scrolling. */}
        <div className="-mt-0.5 max-h-[336px] overflow-y-auto border-t border-muted">
          {rows === null && !error ? (
            <p className="flex h-12 items-center text-md text-faint">
              Loading categories…
            </p>
          ) : null}
          {editing === NEW_ROW ? (
            <div className="flex h-12 items-center gap-3 border-b border-muted">
              {nameField(null)}
            </div>
          ) : null}
          {rows?.length === 0 && editing !== NEW_ROW ? (
            <p className="flex h-12 items-center text-md text-muted-foreground">
              No categories yet.
            </p>
          ) : null}
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
                  {row.count === null ? null : (
                    <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
                      {row.count}
                    </span>
                  )}
                  {row.supply ? (
                    <span className="text-sm whitespace-nowrap text-muted-foreground">
                      Supply
                    </span>
                  ) : null}
                  {busyRow === row.id ? (
                    <Spinner size="sm" label="Saving" className="mx-2" />
                  ) : (
                    <RowActionsMenu label={`Actions for ${row.name}`}>
                      <MenuItem onClick={() => setEditing(row.id)}>
                        <Pencil strokeWidth={1.8} aria-hidden="true" />
                        Rename
                      </MenuItem>
                      {tab === "expense" ? (
                        <MenuCheckItem
                          checked={row.supply}
                          onClick={() => void toggleSupply(row)}
                        >
                          Supply category
                        </MenuCheckItem>
                      ) : null}
                      <MenuItem
                        disabled={row.locked}
                        onClick={() => setDeleteTarget(row)}
                        className="text-destructive data-highlighted:text-destructive data-disabled:text-disabled-foreground"
                      >
                        <Trash2 strokeWidth={1.8} aria-hidden="true" />
                        Delete
                      </MenuItem>
                    </RowActionsMenu>
                  )}
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
          description={deleteTarget ? deleteNote(tab, deleteTarget) : null}
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
