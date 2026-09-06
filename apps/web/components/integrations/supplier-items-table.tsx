"use client"

import * as React from "react"
import { EyeOff, RotateCcw, SquarePen, Trash2 } from "lucide-react"

import {
  deleteSupplierItem,
  ignoreSupplierItem,
  relinkSupplierItem,
  unignoreSupplierItem,
  type SupplierSummary,
} from "@/app/(app)/settings/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { GuardedLink } from "@/components/navigation-blocker"
import { IngredientCombobox } from "@/components/ingredients/ingredient-combobox"
import type { IngredientOption } from "@/components/ingredients/types"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { FilterPill } from "@/components/ui/filter-pill"
import { SearchInput } from "@/components/ui/input"
import { MenuItem } from "@/components/ui/menu"
import { Toolbar } from "@/components/ui/page"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import { TabPill, TabPills } from "@/components/ui/tab-pills"
import { TableBusy, TableFrame } from "@/components/ui/table"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import type {
  SupplierItemIgnoreRow,
  SupplierItemMappingRow,
} from "@/lib/backend/types"
import { formatCents, quantityFormat } from "@/lib/money"
import { cn } from "@/lib/utils"

const MAPPING_PATH = "/integrations/suppliers/mapping"

/** The two mapping tables, in the order a merchant works through them. */
const TABS = [
  { value: "items", label: "Items", href: MAPPING_PATH },
  {
    value: "suppliers",
    label: "Suppliers",
    href: `${MAPPING_PATH}?tab=suppliers`,
  },
] as const

export function SupplierMappingTabs({ tab }: { tab: "items" | "suppliers" }) {
  return (
    <TabPills className="mb-4 w-fit">
      {TABS.map((item) => (
        <TabPill
          key={item.value}
          active={tab === item.value}
          render={<GuardedLink href={item.href} />}
        >
          {item.label}
        </TabPill>
      ))}
    </TabPills>
  )
}

const GRID_ITEMS =
  "grid-cols-[minmax(0,1fr)_128px_96px_minmax(0,190px)_72px_96px_44px] gap-3 min-w-[940px]"
const GRID_IGNORED = "grid-cols-[minmax(0,1fr)_160px_44px] gap-3 min-w-[560px]"

/** The handoff prints "9 Aug" — day then short month, no year. */
const dayMonth = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})

function formatInvoiceDate(value: string | null): string {
  if (!value) return "—"
  return dayMonth.format(new Date(`${value}T00:00:00Z`))
}

function isMappingRow(
  row: SupplierItemMappingRow | SupplierItemIgnoreRow
): row is SupplierItemMappingRow {
  return "packUnit" in row
}

/** A pack with no printed code is known by its description, so that is what
 *  goes where the code would. */
function itemCode(row: SupplierItemMappingRow | SupplierItemIgnoreRow) {
  return row.hasCode ? row.externalId : row.title
}

function packSize(row: SupplierItemMappingRow) {
  const measured = `${quantityFormat.format(row.packAmount)} ${row.packUnit}`
  return row.rawSize ? `${row.rawSize} · ${measured}` : measured
}

/**
 * Suppliers → Mapping: every supplier product Forkluck remembers, and what it
 * buys. A match made here is the same memory the next invoice reads, so a row
 * can be re-pointed at another ingredient, ignored so it is never asked about
 * again, or dropped so it is matched from scratch.
 */
export function SupplierItemsTable({
  rows,
  total,
  offset,
  limit,
  view,
  supplier,
  query,
  suppliers,
  ingredients,
}: {
  rows: Array<SupplierItemMappingRow | SupplierItemIgnoreRow>
  total: number
  offset: number
  limit: number
  view: "all" | "ignored"
  /** A supplier key, or "" for every supplier. */
  supplier: string
  query: string
  suppliers: SupplierSummary[]
  ingredients: IngredientOption[]
}) {
  const browse = useBrowseUrl({ query })
  const { currencyCode } = useBusinessSettings()
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [relinkTarget, setRelinkTarget] =
    React.useState<SupplierItemMappingRow | null>(null)
  const [ignoreTarget, setIgnoreTarget] =
    React.useState<SupplierItemMappingRow | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<SupplierItemMappingRow | null>(null)

  const run = async (
    action: () => Promise<{ ok: true } | { error: string }>
  ) => {
    setPending(true)
    setError(null)
    const result = await action()
    setPending(false)
    if ("error" in result) setError(result.error)
    return !("error" in result)
  }

  const page = Math.floor(offset / limit) + 1
  const pages = Math.max(1, Math.ceil(total / limit))
  const grid = view === "ignored" ? GRID_IGNORED : GRID_ITEMS

  return (
    <>
      <Toolbar>
        <SearchInput
          label="Search items"
          className="max-w-none md:max-w-[196px]"
          value={browse.searchValue}
          onChange={(event) => browse.onSearchValueChange(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2 md:contents">
          <FilterPill
            label="Supplier"
            value={supplier || "all"}
            options={[
              { value: "all", label: "All" },
              ...suppliers.map((row) => ({ value: row.key, label: row.name })),
            ]}
            onSelect={(next) =>
              browse.setFilter("supplier", next === "all" ? null : next)
            }
          />
          <FilterPill
            label="View"
            value={view}
            options={[
              { value: "all", label: "All" },
              { value: "ignored", label: "Ignored" },
            ]}
            onSelect={(next) =>
              browse.setFilter("view", next === "all" ? null : next)
            }
          />
        </div>
      </Toolbar>

      {error ? (
        <p role="alert" className="mb-3 text-base text-destructive">
          {error}
        </p>
      ) : null}

      <TableFrame>
        {browse.isPending ? <TableBusy /> : null}
        <div className="overflow-x-auto">
          <div
            className={cn(
              "grid h-11 items-center border-b border-border px-3.5 text-2xs font-medium text-ink-soft",
              grid
            )}
          >
            <span>Item</span>
            <span>Pack</span>
            {view === "ignored" ? null : (
              <>
                <span className="text-right">Last price</span>
                <span>Ingredient</span>
                <span className="text-right">Times seen</span>
                <span className="text-right">Last invoice</span>
              </>
            )}
            <span />
          </div>

          {rows.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-base text-muted-foreground">
              {view === "ignored"
                ? "Nothing is being skipped."
                : "No supplier items match that filter."}
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className={cn(
                  "grid h-12 items-center border-b border-muted px-3.5 last:border-b-0 hover:bg-fill-soft",
                  grid
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-md text-foreground">
                    {itemCode(row)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.hasCode ? row.title : "No code"} · {row.supplierName}
                  </span>
                </span>
                {isMappingRow(row) ? (
                  <>
                    <span className="truncate text-base text-muted-foreground tabular-nums">
                      {packSize(row)}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {formatCents(row.packPriceCents, currencyCode)}
                    </span>
                    <span className="truncate text-base text-foreground">
                      {row.ingredientName}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {row.timesSeen}
                    </span>
                    <span className="text-right text-base text-muted-foreground tabular-nums">
                      {formatInvoiceDate(row.lastInvoiceDate)}
                    </span>
                    <RowActionsMenu label={`Actions for ${itemCode(row)}`}>
                      <MenuItem onClick={() => setRelinkTarget(row)}>
                        <SquarePen strokeWidth={1.8} aria-hidden="true" />
                        Relink
                      </MenuItem>
                      <MenuItem onClick={() => setIgnoreTarget(row)}>
                        <EyeOff strokeWidth={1.8} aria-hidden="true" />
                        Ignore
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
                ) : (
                  <>
                    <span className="truncate text-base text-muted-foreground tabular-nums">
                      {row.rawSize || "—"}
                    </span>
                    <RowActionsMenu label={`Actions for ${itemCode(row)}`}>
                      <MenuItem
                        disabled={pending}
                        onClick={() =>
                          void run(() =>
                            unignoreSupplierItem(row.supplier, row.externalId)
                          )
                        }
                      >
                        <RotateCcw strokeWidth={1.8} aria-hidden="true" />
                        Unignore
                      </MenuItem>
                    </RowActionsMenu>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </TableFrame>

      <BrowsePagination
        pagination={{
          page,
          limit,
          pages,
          total,
          next: page < pages ? page + 1 : null,
          prev: page > 1 ? page - 1 : null,
        }}
        pending={browse.isPending}
        onPageChange={(next) =>
          browse.setFilter(
            "offset",
            next > 1 ? String((next - 1) * limit) : null
          )
        }
      />

      {/* Mounted per row, so the picker starts on the match it opened on. */}
      {relinkTarget ? (
        <RelinkDialog
          item={relinkTarget}
          ingredients={ingredients}
          pending={pending}
          onClose={() => setRelinkTarget(null)}
          onConfirm={async (ingredientId) => {
            const done = await run(() =>
              relinkSupplierItem(relinkTarget.id, ingredientId)
            )
            if (done) setRelinkTarget(null)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={ignoreTarget !== null}
        onOpenChange={(next) => {
          if (!next) setIgnoreTarget(null)
        }}
        title={`Ignore ${ignoreTarget ? itemCode(ignoreTarget) : ""}?`}
        description="Its pack is removed and its invoice lines are unlinked. The next invoice that prints it is filed as an expense without asking."
        confirmLabel="Ignore"
        pending={pending}
        onConfirm={async () => {
          if (!ignoreTarget) return
          const done = await run(() => ignoreSupplierItem(ignoreTarget.id))
          if (done) setIgnoreTarget(null)
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
        title={`Delete ${deleteTarget ? itemCode(deleteTarget) : ""}?`}
        description="Forkluck forgets what it buys, so the next invoice that prints it is matched from scratch."
        confirmLabel="Delete"
        pending={pending}
        onConfirm={async () => {
          if (!deleteTarget) return
          const done = await run(() => deleteSupplierItem(deleteTarget.id))
          if (done) setDeleteTarget(null)
        }}
      />
    </>
  )
}

/** Re-pointing a pack writes no price: it only changes which ingredient the
 *  next invoice for this code updates. */
function RelinkDialog({
  item,
  ingredients,
  pending,
  onClose,
  onConfirm,
}: {
  item: SupplierItemMappingRow
  ingredients: IngredientOption[]
  pending: boolean
  onClose: () => void
  onConfirm: (ingredientId: string) => void | Promise<void>
}) {
  const [ingredientId, setIngredientId] = React.useState(item.ingredientId)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="gap-0">
        <DialogTitle>Match {itemCode(item)}</DialogTitle>
        <DialogDescription className="mt-1">
          The invoice lines bought under this pack move with it. No price is
          written, so nothing to undo.
        </DialogDescription>
        <div className="mt-3">
          <IngredientCombobox
            id="relink-ingredient"
            value={ingredientId}
            onChange={setIngredientId}
            ingredients={ingredients}
          />
        </div>
        <div className="mt-5 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="flex-1"
            pending={pending}
            disabled={!ingredientId || ingredientId === item.ingredientId}
            onClick={() => void onConfirm(ingredientId)}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
