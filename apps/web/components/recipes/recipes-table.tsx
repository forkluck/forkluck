"use client"

import * as React from "react"
import { undoableToast, useToast } from "@/components/ui/toast"
import {
  Archive,
  ArchiveRestore,
  Copy,
  SquarePen,
  Trash2,
  Upload,
  Users,
} from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import { Badge } from "@/components/ui/badge"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { buttonVariants } from "@/components/ui/button"
import { formatDayMonth } from "@/lib/datetime"
import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DataTable,
  dataTableColumns,
  type DataTableRemote,
} from "@/components/ui/data-table"
import { FilterPill } from "@/components/ui/filter-pill"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { Spinner } from "@/components/ui/spinner"
import { AlertFlag } from "@/components/menu/product-cells"
import { csvCell } from "@/lib/csv"
import { formatCents } from "@/lib/money"
import type { CurrencyCode } from "@/lib/business-settings"
import { recipeCategoryLabel } from "@/lib/recipe/categories"
import { describeRecipeIssues, type RecipeHealth } from "@/lib/recipe/health"
import { toSaveFailure } from "@/lib/save-failure"
import { cn } from "@/lib/utils"
import type { RecipeStatusFilter } from "@/components/recipes/types"
import { ShareRecipesDialog } from "@/components/recipes/share-recipes-dialog"
import {
  deleteRecipe,
  deleteRecipes,
  duplicateRecipe,
  updateRecipeStatuses,
} from "@/app/(app)/recipes/actions"
import { useDialogTarget } from "@/components/ui/dialog"

const helper = dataTableColumns<RecipeHealth>()

/** Secondary cell: 13.5px `--muted-foreground`, one step under the name. */
function Cell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-base whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

const recipeHref = (recipe: RecipeHealth) =>
  `/recipes/${recipe.publicId || recipe.id}/recipe`

const RECIPE_CSV_HEADER = [
  "Title",
  "Code",
  "Category",
  "Status",
  "Cost per portion",
  "Sell price",
  "Food cost %",
  "Updated",
]

/** One CSV row: money as plain decimals, food cost as a percent number. */
function recipeCsvRow(recipe: RecipeHealth): string {
  const money = (cents: number | null) =>
    cents === null ? "" : (cents / 100).toFixed(2)
  return [
    csvCell(recipe.title, { alwaysQuote: true }),
    csvCell(recipe.code),
    csvCell(recipe.category ? recipeCategoryLabel(recipe.category) : ""),
    recipe.status,
    money(recipe.ingredientCents),
    money(recipe.menuPriceCents),
    recipe.foodCost === null ? "" : (recipe.foodCost * 100).toFixed(1),
    recipe.updatedAt.toISOString().slice(0, 10),
  ].join(",")
}

/** Client-side CSV download of the given rows. */
function exportRecipesCsv(rows: RecipeHealth[]) {
  const lines = [RECIPE_CSV_HEADER.join(","), ...rows.map(recipeCsvRow)]
  const blob = new Blob([lines.join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "recipes_export.csv"
  anchor.click()
  URL.revokeObjectURL(url)
}

export function RecipesTable({
  rows,
  currencyCode,
  remote,
  footer,
  status = "active",
  onStatusChange,
  canCreate = true,
}: {
  rows: RecipeHealth[]
  currencyCode: CurrencyCode
  remote?: DataTableRemote
  footer?: React.ReactNode
  status?: RecipeStatusFilter
  onStatusChange?: (value: string | null) => void
  /** A viewer in someone else's kitchen adds nothing to it. */
  canCreate?: boolean
}) {
  const { timezone } = useBusinessSettings()
  const toast = useToast()
  const { go } = useGuardedNavigate()
  const [deleteTarget, setDeleteTarget] = React.useState<RecipeHealth | null>(
    null
  )
  // Transitions: the wait on a control holds until the rows the action
  // answered with have committed, not just until it answered. After an await
  // React has lost the transition's scope, so the updates that should land
  // with those rows start it again.
  const [deletePending, startDelete] = React.useTransition()
  const [statusPending, startStatus] = React.useTransition()
  // Mounted only while it is open, so each send starts on an empty form.
  const [shareTarget, setShareTarget] = React.useState<{
    recipes: { id: string; title: string }[]
    clear: () => void
  } | null>(null)
  const heldShare = useDialogTarget(shareTarget)
  const [hiddenRowIds, setHiddenRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const data = React.useMemo(
    () => rows.filter((row) => !hiddenRowIds.has(row.id)),
    [hiddenRowIds, rows]
  )
  const canViewCost = rows.some((row) => row.canViewCost ?? true)

  // The row whose menu action is in flight: the menu has closed, so the row
  // shows the wait, and a toast says what came of it.
  const [busyId, setBusyId] = React.useState<string | null>(null)

  // The action revalidates the list, so its answer carries the new row. The
  // busy mark is set before the transition: React holds updates made inside
  // an async transition until the action has finished.
  const duplicate = React.useCallback(
    (recipe: RecipeHealth) => {
      setBusyId(recipe.id)
      startStatus(async () => {
        try {
          const result = await duplicateRecipe(recipe.id)
          if ("error" in result) {
            toast.add({ title: result.error, type: "error" })
            return
          }
          startStatus(() => {
            toast.add({ title: `Duplicated ${recipe.title}` })
          })
        } catch (cause) {
          toast.add({ title: toSaveFailure(cause).message, type: "error" })
        } finally {
          startStatus(() => setBusyId(null))
        }
      })
    },
    [toast]
  )

  // One row shows the wait on itself; a selection shows it on the menu that
  // asked. Either way the status changes when the server says so, in one
  // request for the whole selection, and a toast names what changed and
  // offers the way back: Undo is this same function with the opposite
  // status, so it waits and reports exactly as the first press did.
  const setStatus = React.useCallback(
    function setStatus(
      recipes: RecipeHealth[],
      next: "active" | "archived"
    ): Promise<boolean> {
      if (recipes.length === 1) setBusyId(recipes[0].id)
      return new Promise<boolean>((resolve) =>
        startStatus(async () => {
          try {
            const result = await updateRecipeStatuses(
              recipes.map((recipe) => recipe.id),
              next
            )
            if ("error" in result) throw new Error(result.error)
            startStatus(() => {
              undoableToast(
                toast,
                `${next === "archived" ? "Archived" : "Restored"} ${
                  recipes.length === 1
                    ? recipes[0].title
                    : `${recipes.length} recipes`
                }`,
                () =>
                  setStatus(
                    recipes,
                    next === "archived" ? "active" : "archived"
                  )
              )
            })
            resolve(true)
          } catch (cause) {
            toast.add({ title: toSaveFailure(cause).message, type: "error" })
            resolve(false)
          } finally {
            startStatus(() => setBusyId(null))
          }
        })
      )
    },
    [toast]
  )

  // Nothing on screen changes until the server has answered: the row goes,
  // then the confirmation, then the toast.
  const confirmDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    startDelete(async () => {
      try {
        const result = await deleteRecipe(target.id)
        if ("error" in result) {
          toast.add({ title: result.error, type: "error" })
          return
        }
      } catch (cause) {
        toast.add({ title: toSaveFailure(cause).message, type: "error" })
        return
      }
      startDelete(() => {
        setHiddenRowIds((current) => new Set(current).add(target.id))
        setDeleteTarget(null)
        toast.add({ title: `Deleted ${target.title}` })
      })
    })
  }

  // One menu, two placements: the row's trailing cell and the mobile card.
  const rowActions = React.useCallback(
    (recipe: RecipeHealth) =>
      busyId === recipe.id ? (
        <Spinner size="sm" label="Working" className="size-8" />
      ) : (
        <RowActionsMenu label={`Actions for ${recipe.title}`}>
          <MenuItem onClick={() => go(recipeHref(recipe))}>
            <SquarePen strokeWidth={1.8} aria-hidden="true" />
            {recipe.canEdit === false ? "View" : "Edit"}
          </MenuItem>
          {recipe.permission && recipe.permission !== "owner" ? null : (
            <>
              <MenuItem onClick={() => void duplicate(recipe)}>
                <Copy strokeWidth={1.8} aria-hidden="true" />
                Duplicate
              </MenuItem>
              {recipe.status === "archived" ? (
                <MenuItem onClick={() => void setStatus([recipe], "active")}>
                  <ArchiveRestore strokeWidth={1.8} aria-hidden="true" />
                  Unarchive
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void setStatus([recipe], "archived")}>
                  <Archive strokeWidth={1.8} aria-hidden="true" />
                  Archive
                </MenuItem>
              )}
              <MenuItem
                onClick={() => setDeleteTarget(recipe)}
                className="text-destructive data-highlighted:text-destructive"
              >
                <Trash2 strokeWidth={1.8} aria-hidden="true" />
                Delete
              </MenuItem>
            </>
          )}
        </RowActionsMenu>
      ),
    [busyId, duplicate, go, setStatus]
  )

  const columns = React.useMemo(
    () => [
      helper.accessor((row) => row.title, {
        id: "recipe",
        header: "Recipe",
        // The row's identity — hiding it would leave nameless rows.
        enableHiding: false,
        meta: { className: "max-w-0", minWidth: 260 },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <GuardedLink
              href={recipeHref(row.original)}
              className="min-w-0 truncate text-foreground"
            >
              {row.original.title}
            </GuardedLink>
            {row.original.status === "archived" ? (
              <Badge size="row" className="rounded-sm px-[7px] text-2xs">
                Archived
              </Badge>
            ) : null}
          </span>
        ),
      }),
      // Its own slim column, so the triangles line up instead of trailing
      // names of every length. Empty for a recipe with nothing to fix.
      helper.display({
        id: "alerts",
        enableHiding: false,
        // 56px, not 44: the flag's chevron needs room to the right, or it sits
        // glued to the next column's text.
        meta: { align: "center", className: "w-14", minWidth: 56 },
        cell: ({ row }) => {
          const alerts = describeRecipeIssues(row.original.issues)
          if (!alerts.length) return null
          return <AlertFlag label={alerts} width={260} />
        },
      }),
      helper.accessor(
        (row) => (row.category ? recipeCategoryLabel(row.category) : ""),
        {
          id: "category",
          header: "Category",
          meta: { className: "w-[20%]", minWidth: 140 },
          cell: ({ getValue }) => <Cell>{(getValue() as string) || "–"}</Cell>,
        }
      ),
      ...(canViewCost
        ? [
            helper.accessor((row) => row.ingredientCents, {
              id: "ingredientCost",
              header: "Ingredient cost",
              meta: { align: "right", className: "w-[14%]", minWidth: 120 },
              // An understated cost is the alerts column's story; the cell
              // itself stays a number.
              cell: ({ row }) => (
                <Cell>
                  {row.original.ingredientCents !== null
                    ? `${formatCents(row.original.ingredientCents, currencyCode)}${row.original.suffix}`
                    : "–"}
                </Cell>
              ),
            }),
          ]
        : []),
      helper.accessor((row) => row.updatedAt.getTime(), {
        id: "updated",
        header: "Last updated",
        meta: { align: "right", className: "w-[11%]", minWidth: 120 },
        cell: ({ row }) => (
          <Cell>{formatDayMonth(row.original.updatedAt, timezone)}</Cell>
        ),
      }),
      helper.display({
        id: "actions",
        enableHiding: false,
        meta: { align: "right", className: "w-11", minWidth: 44 },
        cell: ({ row }) => rowActions(row.original),
      }),
    ],
    [canViewCost, currencyCode, rowActions, timezone]
  )

  return (
    <>
      <DataTable
        columns={columns}
        data={data}
        getRowId={(row) => row.id}
        enableSelection
        tableClassName="table-fixed"
        remote={remote}
        footer={footer}
        columnsMenu={{
          storageKey: "recipes",
          headerColumnId: "actions",
        }}
        toolbarLeading={
          <FilterPill
            label="Status"
            value={status ?? "all"}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
            onSelect={(value) =>
              onStatusChange?.(value === "all" ? null : value)
            }
          />
        }
        emptyMessage="No recipes match your search."
        toolbarExtra={({ selectedRows, clearSelection }) => {
          const owned = selectedRows.filter(
            (recipe) => !recipe.permission || recipe.permission === "owner"
          )
          const archive = async (next: "active" | "archived") => {
            if (await setStatus(owned, next)) clearSelection()
          }
          return (
            <>
              <ActionsMenu>
                <MenuItem
                  // A share sends the whole selection or none of it: a row
                  // someone else owns is not the owner's to pass on.
                  disabled={
                    selectedRows.length === 0 ||
                    owned.length !== selectedRows.length
                  }
                  onClick={() =>
                    setShareTarget({
                      recipes: selectedRows.map((recipe) => ({
                        id: recipe.id,
                        title: recipe.title,
                      })),
                      clear: clearSelection,
                    })
                  }
                >
                  <Users strokeWidth={1.8} aria-hidden="true" />
                  {selectedRows.length === 1 ? "Share recipe" : "Share recipes"}
                </MenuItem>
                <MenuItem
                  disabled={owned.length === 0 || statusPending}
                  onClick={() => void archive("archived")}
                >
                  <Archive strokeWidth={1.8} aria-hidden="true" />
                  Archive selected
                </MenuItem>
                <MenuItem
                  disabled={owned.length === 0 || statusPending}
                  onClick={() => void archive("active")}
                >
                  <ArchiveRestore strokeWidth={1.8} aria-hidden="true" />
                  Restore selected
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    exportRecipesCsv(selectedRows.length ? selectedRows : data)
                  }
                >
                  <Upload strokeWidth={1.8} aria-hidden="true" />
                  {selectedRows.length
                    ? `Export ${selectedRows.length} recipe${
                        selectedRows.length === 1 ? "" : "s"
                      }`
                    : remote
                      ? "Export this page"
                      : "Export recipes"}
                </MenuItem>
              </ActionsMenu>
              {canCreate ? (
                <GuardedLink
                  href="/recipes/new"
                  className={cn(buttonVariants())}
                >
                  Add recipe
                </GuardedLink>
              ) : null}
            </>
          )
        }}
        onRowClick={(row) => go(recipeHref(row))}
        bulkActions={({ rows: selected, clear }) => {
          const deletable = selected.filter(
            (recipe) => recipe.canDelete ?? true
          )
          if (!deletable.length) return null
          return (
            <BulkDeleteMenu
              count={deletable.length}
              noun="recipe"
              description="They are removed, along with their labor timings. Products that use them keep their sales history."
              refreshAfterDelete={false}
              onDelete={async () => {
                const result = await deleteRecipes(
                  deletable.map((recipe) => recipe.id)
                )
                if ("error" in result) throw new Error(result.error)
              }}
              onDeleted={clear}
            />
          )
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteTarget(null)
        }}
        title="Delete this recipe?"
        description={`${deleteTarget?.title ?? "This recipe"} is removed, along with its labor timings. Products that use it keep their sales history.`}
        confirmLabel={deletePending ? "Deleting…" : "Delete recipe"}
        pending={deletePending}
        onConfirm={confirmDelete}
      />
      {heldShare ? (
        <ShareRecipesDialog
          open={shareTarget !== null}
          onOpenChange={(next) => {
            if (!next) setShareTarget(null)
          }}
          recipes={heldShare.recipes}
          onShared={heldShare.clear}
        />
      ) : null}
    </>
  )
}
