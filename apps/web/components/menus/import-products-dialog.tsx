"use client"

import * as React from "react"

import { loadMenuProducts } from "@/app/(app)/menu/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SearchInput } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { SalesProductRow } from "@/lib/backend/types"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { formatCents, quantityFormat } from "@/lib/money"

/**
 * What the units and money in these rows are counted over.
 *
 * A menu without dates is priced on the whole ledger, so the caption has to
 * say which of the two the figures came from.
 */
export function menuPeriodCaption(
  periodStart: string | null,
  periodEnd: string | null
) {
  return periodStart && periodEnd
    ? `${formatDateRangeLabel(periodStart, periodEnd)} · Units and sales for this menu’s period.`
    : "All time · Units and sales across the whole ledger."
}

/**
 * The 100 busiest products over the menu's period; search reaches the rest.
 *
 * Products is a catalog and reports no sales, so this reads the worksheet's
 * own endpoint: units and attributed money for the days the menu ran, or
 * all-time when it names no period.
 */
export function useMenuProductRows(
  open: boolean,
  query: string,
  periodStart: string | null,
  periodEnd: string | null
) {
  const [rows, setRows] = React.useState<SalesProductRow[]>([])
  const [pending, setPending] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRows([])
      setPending(true)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      setPending(true)
      void loadMenuProducts({
        q: query.trim() || undefined,
        start: periodStart,
        end: periodEnd,
      }).then((result) => {
        if (!live) return
        setPending(false)
        if ("error" in result) {
          setError(result.error)
          setRows([])
          return
        }
        setError(null)
        setRows(result.items)
      })
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, query, periodStart, periodEnd])

  return { rows, pending, error }
}

export function ImportProductsDialog({
  open,
  onOpenChange,
  periodStart,
  periodEnd,
  existingProductIds,
  currencyCode,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  periodStart: string | null
  periodEnd: string | null
  existingProductIds: Set<string>
  currencyCode: string
  onImport: (rows: SalesProductRow[]) => void
}) {
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<string[]>([])
  const { rows, pending, error } = useMenuProductRows(
    open,
    query,
    periodStart,
    periodEnd
  )
  // Every row the dialog has shown, so a selection survives a new search.
  const seen = React.useRef(new Map<string, SalesProductRow>())
  React.useEffect(() => {
    for (const row of rows) seen.current.set(row.id, row)
  }, [rows])

  React.useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("")
    setSelected([])
  }, [open])

  const selectable = rows.filter((row) => !existingProductIds.has(row.id))
  const allSelected =
    selectable.length > 0 &&
    selectable.every((row) => selected.includes(row.id))
  const someSelected = selectable.some((row) => selected.includes(row.id))

  const toggleRow = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, id] : current.filter((one) => one !== id)
    )
  const toggleAll = (checked: boolean) =>
    setSelected((current) => {
      const ids = selectable.map((row) => row.id)
      if (!checked) return current.filter((one) => !ids.includes(one))
      return [...current, ...ids.filter((one) => !current.includes(one))]
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One fixed height: a narrowed search moves the rows, never the
          dialog. Only the list scrolls. */}
      <DialogContent size="md" className="flex h-[min(640px,85dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>Import from products</DialogTitle>
          <DialogDescription>
            {menuPeriodCaption(periodStart, periodEnd)}
          </DialogDescription>
        </DialogHeader>
        <SearchInput
          className="max-w-none"
          label="Search products"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-base text-destructive">
            {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {pending && rows.length === 0 ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner size="sm" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-base text-muted-foreground">
              No products match.
            </p>
          ) : (
            <>
              <label className="flex h-9 items-center gap-3 border-b border-muted text-xs font-medium text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  disabled={selectable.length === 0}
                  onCheckedChange={toggleAll}
                  aria-label="Select all products"
                />
                <span className="min-w-0 flex-1">Product</span>
                <span className="hidden w-16 text-right sm:block">Units</span>
                <span className="hidden w-24 text-right sm:block">Sales</span>
              </label>
              {rows.map((row) => {
                const onMenu = existingProductIds.has(row.id)
                return (
                  <label
                    key={row.id}
                    className="flex items-center gap-3 border-b border-muted py-2.5 text-base last:border-b-0 sm:h-11 sm:py-0"
                  >
                    <Checkbox
                      checked={onMenu || selected.includes(row.id)}
                      disabled={onMenu}
                      onCheckedChange={(checked) =>
                        toggleRow(row.id, checked === true)
                      }
                      aria-label={row.name}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate">{row.name}</span>
                        {onMenu ? (
                          <Badge size="row" variant="secondary">
                            On menu
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-faint tabular-nums sm:hidden">
                        {quantityFormat.format(row.sales.totalQuantity)} units ·{" "}
                        {row.sales.sharedToMembers
                          ? "Shared"
                          : formatCents(
                              row.sales.attributedNetSalesCents,
                              currencyCode
                            )}
                      </span>
                    </span>
                    <span className="hidden w-16 text-right text-muted-foreground tabular-nums sm:block">
                      {quantityFormat.format(row.sales.totalQuantity)}
                    </span>
                    <span className="hidden w-24 text-right text-muted-foreground tabular-nums sm:block">
                      {row.sales.sharedToMembers
                        ? "Shared"
                        : formatCents(
                            row.sales.attributedNetSalesCents,
                            currencyCode
                          )}
                    </span>
                  </label>
                )
              })}
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0}
            onClick={() => {
              onImport(
                selected
                  .map((id) => seen.current.get(id))
                  .filter((row): row is SalesProductRow => row !== undefined)
              )
              onOpenChange(false)
            }}
          >
            Import {selected.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
