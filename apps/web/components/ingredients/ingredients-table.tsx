"use client"

import * as React from "react"
import { useToast } from "@/components/ui/toast"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { Download, Package, SquarePen, Trash2, Upload } from "lucide-react"

import {
  deleteIngredient,
  loadIngredientDetail,
} from "@/app/(app)/ingredients/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { formatDayMonth } from "@/lib/datetime"
import { DuplicateIngredientsBanner } from "@/components/ingredients/duplicate-ingredients-banner"
import { IngredientDeleteDialog } from "@/components/ingredients/ingredient-delete-dialog"
import { IngredientOptionsLoadingDialog } from "@/components/ingredients/ingredient-options-loading-dialog"
import {
  GuardedLink,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import type {
  IngredientKind,
  IngredientStatusFilter,
} from "@/components/ingredients/types"
import { FilterPill } from "@/components/ui/filter-pill"
import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { Button } from "@/components/ui/button"
import { DataTable, dataTableColumns } from "@/components/ui/data-table"
import type { DataTableRemote } from "@/components/ui/data-table"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { formatCents } from "@/lib/money"
import type { IngredientDetail, IngredientSummary } from "@/lib/backend/types"
import type { DuplicateSuggestion } from "@/lib/ingredient-insights"
import { preferredWeightUnit } from "@/lib/business-settings"
import { csvCell } from "@/lib/csv"
import { centsPerWeightUnit, formatUnitPrice } from "@/lib/pricing"
import { formatPackSize } from "@/lib/unit-registry"
import { useIngredientOptions } from "@/hooks/use-ingredient-options"

// Each carries its own boundary: without one, a chunk still on its way
// suspends up to the route's full-page spinner and the list flashes away.
const ImportIngredientsDialog = dynamic(
  () =>
    import("@/components/ingredients/import-dialog").then(
      (module) => module.ImportIngredientsDialog
    ),
  { loading: () => null }
)
const SupplierProductsDialog = dynamic(
  () =>
    import("@/components/ingredients/supplier-products-dialog").then(
      (module) => module.SupplierProductsDialog
    ),
  { loading: () => null }
)

/** Secondary cell: 13.5px `--muted-foreground`, one step under the name. */
function Cell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-base whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

const helper = dataTableColumns<IngredientSummary>()

/** The two lists are the same table over the same rows; only the words, the
 *  column memory and the pantry-only import tools differ. */
const KIND_COPY = {
  food: {
    noun: "ingredient",
    plural: "ingredients",
    column: "Ingredient",
    addHref: "/ingredients/new",
    storageKey: "ingredients",
    csvFile: "ingredients_export.csv",
    emptyMessage: "No ingredients match your search.",
    deleteDescription: "Recipes that use them will show a missing cost.",
  },
  supply: {
    noun: "supply",
    plural: "supplies",
    column: "Supply",
    addHref: "/supplies/new",
    storageKey: "supplies",
    csvFile: "supplies_export.csv",
    emptyMessage: "No supplies match your search.",
    deleteDescription: "Products that use them will show a missing cost.",
  },
} as const

const ingredientPrice = (cents: number, currencyCode: string) =>
  cents > 0 ? formatCents(cents, currencyCode) : "–"

const ingredientUnitPrice = (
  ingredient: IngredientSummary,
  unit: Parameters<typeof formatUnitPrice>[3],
  currencyCode: string
) =>
  ingredient.purchaseCostCents > 0
    ? formatUnitPrice(
        ingredient.purchaseCostCents,
        ingredient.purchaseSize,
        ingredient.purchaseUnit,
        unit,
        currencyCode
      )
    : "–"

/** Client-side CSV download of the given rows. */
function exportIngredientsCsv(rows: IngredientSummary[], fileName: string) {
  const money = (cents: number) => (cents / 100).toFixed(2)
  const lines = [
    ["Name", "Purchase size", "Purchase unit", "Purchase cost", "Updated"].join(
      ","
    ),
    ...rows.map((row) =>
      [
        csvCell(row.name, { alwaysQuote: true }),
        row.purchaseSize ?? "",
        row.purchaseUnit ?? "",
        money(row.purchaseCostCents),
        row.updatedAt.toISOString().slice(0, 10),
      ].join(",")
    ),
  ]
  const blob = new Blob([lines.join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export function IngredientsTable({
  ingredients,
  duplicateSuggestions = [],
  kind = "food",
  status = "active",
  onStatusChange,
  remote,
  footer,
}: {
  ingredients: IngredientSummary[]
  duplicateSuggestions?: DuplicateSuggestion[]
  /** Which list this is: supplies carry their own words and column memory. */
  kind?: IngredientKind
  status?: IngredientStatusFilter
  onStatusChange?: (value: string | null) => void
  remote?: DataTableRemote
  footer?: React.ReactNode
}) {
  const copy = KIND_COPY[kind]
  const counted = (count: number) =>
    `${count} ${count === 1 ? copy.noun : copy.plural}`
  const router = useRouter()
  const toast = useToast()
  const { allowNavigation, confirmNavigation } = useNavigationBlocker()
  const { currencyCode, measurementSystem, timezone } = useBusinessSettings()
  const unitPriceUnit = preferredWeightUnit(measurementSystem)
  // One dialog instance each, shared by every row and opened from its menu.
  const [packs, setPacks] = React.useState<IngredientDetail | null>(null)
  const [detailPending, setDetailPending] = React.useState<string | null>(null)
  const [openDialog, setOpenDialog] = React.useState<"import" | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<IngredientSummary | null>(null)
  const [hiddenRowIds, setHiddenRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const rows = React.useMemo(
    () => ingredients.filter((row) => !hiddenRowIds.has(row.id)),
    [hiddenRowIds, ingredients]
  )
  const {
    options: ingredientOptions,
    status: ingredientOptionsStatus,
    load: loadOptions,
  } = useIngredientOptions()
  const go = React.useCallback(
    async (href: string) => {
      if (!(await confirmNavigation())) return
      allowNavigation()
      router.push(href)
    },
    [allowNavigation, confirmNavigation, router]
  )
  const openSupplierPacks = React.useCallback(
    async (ingredient: IngredientSummary) => {
      setDetailPending(ingredient.id)
      const result = await loadIngredientDetail(ingredient.publicId)
      setDetailPending(null)
      if (!("error" in result)) setPacks(result)
    },
    []
  )

  const rowActions = React.useCallback(
    (ingredient: IngredientSummary) => (
      <RowActionsMenu label={`Actions for ${ingredient.name}`}>
        <MenuItem
          onClick={() =>
            void go(`/ingredients/${ingredient.publicId}/ingredient`)
          }
        >
          <SquarePen strokeWidth={1.8} aria-hidden="true" />
          Edit
        </MenuItem>
        <MenuItem
          disabled={detailPending === ingredient.id}
          onClick={() => void openSupplierPacks(ingredient)}
        >
          <Package strokeWidth={1.8} aria-hidden="true" />
          {detailPending === ingredient.id
            ? "Loading packs…"
            : "Supplier packs"}
        </MenuItem>
        <MenuItem
          onClick={() => setDeleteTarget(ingredient)}
          className="text-destructive data-highlighted:text-destructive"
        >
          <Trash2 strokeWidth={1.8} aria-hidden="true" />
          Delete
        </MenuItem>
      </RowActionsMenu>
    ),
    [detailPending, go, openSupplierPacks]
  )

  const columns = React.useMemo(
    () => [
      helper.accessor((row) => row.name, {
        id: "ingredient",
        header: copy.column,
        // The row's identity — hiding it would leave nameless rows.
        enableHiding: false,
        meta: { className: "max-w-0", minWidth: 260 },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{row.original.name}</span>
            {row.original.status === "archived" ? (
              <span className="shrink-0 text-2xs text-muted-foreground">
                Archived
              </span>
            ) : null}
          </span>
        ),
      }),
      helper.accessor((row) => row.purchaseSize ?? undefined, {
        id: "pack",
        header: "Pack",
        sortUndefined: "last",
        meta: { align: "right", className: "w-[15%]", minWidth: 100 },
        cell: ({ row }) => (
          <Cell>
            {formatPackSize(
              row.original.purchaseSize,
              row.original.purchaseUnit,
              measurementSystem
            )}
          </Cell>
        ),
      }),
      helper.accessor((row) => row.purchaseCostCents, {
        id: "price",
        header: "Price",
        meta: { align: "right", className: "w-[12%]", minWidth: 100 },
        cell: ({ row }) => (
          <Cell>
            {ingredientPrice(row.original.purchaseCostCents, currencyCode)}
          </Cell>
        ),
      }),
      // An ingredient with no weight has no price per unit; it sinks to the
      // bottom rather than sorting as the cheapest thing in the pantry.
      helper.accessor(
        (row) =>
          centsPerWeightUnit(
            row.purchaseCostCents,
            row.purchaseSize,
            row.purchaseUnit,
            unitPriceUnit
          ) ?? undefined,
        {
          id: "unitPrice",
          sortUndefined: "last",
          header: `${currencyCode} / ${unitPriceUnit}`,
          meta: { align: "right", className: "w-[14%]", minWidth: 120 },
          cell: ({ row }) => (
            <Cell>
              {ingredientUnitPrice(row.original, unitPriceUnit, currencyCode)}
            </Cell>
          ),
        }
      ),
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
    [
      copy.column,
      currencyCode,
      measurementSystem,
      rowActions,
      timezone,
      unitPriceUnit,
    ]
  )

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        enableSelection
        tableClassName="table-fixed"
        remote={remote}
        footer={footer}
        columnsMenu={{
          storageKey: copy.storageKey,
          defaultHidden: ["pack", "price", "unitPrice"],
          headerColumnId: "actions",
        }}
        notice={
          kind === "food" ? (
            <DuplicateIngredientsBanner duplicates={duplicateSuggestions} />
          ) : null
        }
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
        toolbarExtra={({ selectedRows }) => (
          <>
            <ActionsMenu className="w-[196px]">
              {/* Import writes food rows, so it stays on the pantry list. */}
              {kind === "food" ? (
                <MenuItem
                  onClick={() => {
                    setOpenDialog("import")
                    void loadOptions()
                  }}
                >
                  <Download strokeWidth={1.8} aria-hidden="true" />
                  Import ingredients
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() =>
                  exportIngredientsCsv(
                    selectedRows.length ? selectedRows : rows,
                    copy.csvFile
                  )
                }
              >
                <Upload strokeWidth={1.8} aria-hidden="true" />
                {selectedRows.length
                  ? `Export ${counted(selectedRows.length)}`
                  : remote
                    ? "Export this page"
                    : `Export ${copy.plural}`}
              </MenuItem>
            </ActionsMenu>
            <Button
              nativeButton={false}
              render={<GuardedLink href={copy.addHref} />}
            >
              Add {copy.noun}
            </Button>
          </>
        )}
        emptyMessage={copy.emptyMessage}
        onRowClick={(row) => void go(`/ingredients/${row.publicId}/ingredient`)}
        bulkActions={({ rows: selected, clear }) => (
          <BulkDeleteMenu
            count={selected.length}
            noun={copy.noun}
            description={copy.deleteDescription}
            refreshAfterDelete={false}
            onDelete={async () => {
              const deleted: string[] = []
              try {
                for (const ingredient of selected) {
                  const result = await deleteIngredient(ingredient.id)
                  if ("error" in result) throw new Error(result.error)
                  deleted.push(ingredient.id)
                }
              } finally {
                if (deleted.length) {
                  setHiddenRowIds((current) => {
                    const next = new Set(current)
                    for (const id of deleted) next.add(id)
                    return next
                  })
                  toast.add({
                    title: `Deleted ${counted(deleted.length)}`,
                  })
                }
              }
              clear()
            }}
          />
        )}
      />

      {packs ? (
        <SupplierProductsDialog
          ingredient={packs}
          open
          onOpenChange={(open) => {
            if (!open) setPacks(null)
          }}
        />
      ) : null}

      {openDialog === "import" && ingredientOptionsStatus === "ready" ? (
        <ImportIngredientsDialog
          ingredients={ingredientOptions}
          open
          onOpenChange={(open) => {
            if (!open) setOpenDialog(null)
          }}
        />
      ) : openDialog === "import" ? (
        <IngredientOptionsLoadingDialog
          open
          error={ingredientOptionsStatus === "error"}
          onOpenChange={(open) => {
            if (!open) setOpenDialog(null)
          }}
          onRetry={() => void loadOptions()}
        />
      ) : null}

      {deleteTarget ? (
        <IngredientDeleteDialog
          key={deleteTarget.id}
          ingredient={deleteTarget}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          onDeleted={() => {
            setHiddenRowIds((current) => new Set(current).add(deleteTarget.id))
            setDeleteTarget(null)
          }}
        />
      ) : null}
    </>
  )
}
