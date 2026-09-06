"use client"

import * as React from "react"

import { recordManualSales } from "@/app/(app)/products/actions"
import { ChannelIcon } from "@/components/menu/product-cells"
import { AddButton } from "@/components/ui/add-button"
import { Badge } from "@/components/ui/badge"
import { BrowsePagination } from "@/components/ui/browse-pagination"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { FilterPill } from "@/components/ui/filter-pill"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import { dollarsToCents, formatCents, quantityFormat } from "@/lib/money"
import type { ProductDetail } from "@/lib/backend/types"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { useRefresh } from "@/hooks/use-refresh"

type ProductManualSaleRow = ProductDetail["sales"]["manualSales"][number]

function channelLabel(channel: string) {
  if (channel === "square") return "Square"
  if (channel === "shopify") return "Shopify"
  if (channel === "manual") return "Manual"
  return channel || "Sales channel"
}

function dateLabel(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

function manualRowsWithMissingTotals(rows: ProductManualSaleRow[]) {
  return rows.filter((row) => row.totalNetCents === null).length
}

/** Which figures a surface reads. "Including bundles" moves a box's money to
    the products inside it; "As sold" is what the box's own variants recorded. */
const SALES_PAGE_SIZE = 5

type SalesView = "expanded" | "asSold"

/** Missing while the backend emitting it is still rolling out: a product with
    no bundle around it sold exactly what it was sold as. */
function asSoldSales(product: ProductDetail) {
  return product.salesAsSold ?? product.sales
}

function dailyRows(product: ProductDetail, view: SalesView) {
  const sales = view === "asSold" ? asSoldSales(product) : product.sales
  return [...sales.dailySales].sort((left, right) =>
    right.soldOn.localeCompare(left.soldOn)
  )
}

function manualRows(product: ProductDetail) {
  return [...product.sales.manualSales].sort((left, right) =>
    right.soldOn.localeCompare(left.soldOn)
  )
}

function ManualSalesForm({
  product,
  onRecorded,
}: {
  product: ProductDetail
  onRecorded: () => void
}) {
  const { refresh } = useRefresh()
  const [soldOn, setSoldOn] = React.useState("")
  const [quantity, setQuantity] = React.useState("")
  const [totalNet, setTotalNet] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const parsedQuantity = Number(quantity)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(soldOn)) {
      setError("Choose a valid sale date.")
      return
    }
    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
      setError("Enter a quantity of zero or more.")
      return
    }
    const parsedTotal = totalNet.trim() ? dollarsToCents(totalNet) : null
    if (totalNet.trim() && parsedTotal === null) {
      setError("Enter a valid total net amount.")
      return
    }

    setPending(true)
    try {
      const result = await recordManualSales({
        productId: product.publicId,
        soldOn,
        quantity: parsedQuantity,
        ...(parsedTotal === null ? {} : { totalNetCents: parsedTotal }),
      })
      if ("error" in result) {
        setError(result.error)
        return
      }
      setSoldOn("")
      setQuantity("")
      setTotalNet("")
      await refresh()
      onRecorded()
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          Record manual sales
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Add one day at a time for sales that did not come from a connected
          channel. Use zero quantity to remove that day.
        </p>
      </div>
      <FieldGroup className="mt-5 gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="manual-sale-date">Sold on</FieldLabel>
            <Input
              id="manual-sale-date"
              aria-label="Sold on"
              type="date"
              value={soldOn}
              onChange={(event) => setSoldOn(event.target.value)}
              aria-invalid={error ? true : undefined}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="manual-sale-quantity">Quantity</FieldLabel>
            <Input
              id="manual-sale-quantity"
              aria-label="Quantity"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              aria-invalid={error ? true : undefined}
              required
            />
            <FieldDescription>Zero removes the entry.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="manual-sale-total">Total net</FieldLabel>
            <Input
              id="manual-sale-total"
              aria-label="Total net"
              inputMode="decimal"
              placeholder="Optional"
              value={totalNet}
              onChange={(event) => setTotalNet(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button type="submit" size="lg" pending={pending}>
            Record sale
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

function ManualSalesTable({ product }: { product: ProductDetail }) {
  const { refresh } = useRefresh()
  const rows = manualRows(product)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function remove(row: ProductManualSaleRow) {
    setError(null)
    setPendingId(row.id)
    try {
      const result = await recordManualSales({
        productId: product.publicId,
        soldOn: row.soldOn,
        quantity: 0,
      })
      if ("error" in result) {
        setError(result.error)
        return
      }
      await refresh()
    } finally {
      setPendingId(null)
    }
  }

  if (!rows.length) return null

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            Manual entries
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            These quantities are included in the product view.
          </p>
        </div>
        <Badge variant="secondary">{rows.length} entries</Badge>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table className="min-w-[380px]">
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Total net</TableHead>
              <TableHead className="w-20" />
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {dateLabel(row.soldOn)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {quantityFormat.format(row.quantity)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.totalNetCents === null
                    ? "—"
                    : formatCents(row.totalNetCents, product.currencyCode)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    pending={pendingId === row.id}
                    onClick={() => void remove(row)}
                    aria-label={`Remove manual sale ${row.soldOn}`}
                  >
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function IncompleteBanner({ product }: { product: ProductDetail }) {
  const missingCount = manualRowsWithMissingTotals(manualRows(product))
  return (
    <div className="rounded-xl border border-border bg-fill-soft px-4 py-3 text-sm text-muted-foreground">
      {missingCount > 0
        ? `${missingCount} manual ${missingCount === 1 ? "sale is" : "sales are"} missing a total net amount.`
        : "Manual revenue details are incomplete; enter total net amounts to include them."}
    </div>
  )
}

/** The ledger itself, under the product's composition: every day the product
    sold, whichever channel recorded it, with manual entry behind the dialog. */
export function ProductSalesSection({
  product,
  period,
  initialView = "expanded",
}: {
  product: ProductDetail
  period?: { startDate: string; endDate: string }
  initialView?: SalesView
}) {
  const [open, setOpen] = React.useState(false)
  const [view, setView] = React.useState<SalesView>(initialView)
  const [page, setPage] = React.useState(1)
  const all = dailyRows(product, view)
  const totals = view === "asSold" ? asSoldSales(product) : product.sales
  // Five days at a time: the table is a ledger to scan, not a report.
  const pages = Math.max(1, Math.ceil(all.length / SALES_PAGE_SIZE))
  const current = Math.min(page, pages)
  const rows = all.slice(
    (current - 1) * SALES_PAGE_SIZE,
    current * SALES_PAGE_SIZE
  )
  return (
    <section aria-labelledby="product-sales-heading">
      {/* Stacked on phones; md:items-center, not baseline, for the 32px pill. */}
      <div className="mb-2 flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
        <div className="flex items-baseline gap-2">
          <h2
            id="product-sales-heading"
            className="text-lg font-semibold text-foreground"
          >
            Sales
          </h2>
          <span className="text-xs text-faint">
            {period
              ? formatDateRangeLabel(period.startDate, period.endDate)
              : `${all.length} days`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <FilterPill
            label="View"
            contentClassName="w-[200px]"
            value={view}
            options={[
              { value: "expanded", label: "Including bundles" },
              { value: "asSold", label: "As sold" },
            ]}
            onSelect={(next) => {
              setView(next)
              setPage(1)
            }}
          />
          <AddButton
            label="Record sale"
            variant="outline"
            onClick={() => setOpen(true)}
          />
        </div>
      </div>
      {product.incompleteManualRevenue ? (
        <div className="mb-3">
          <IncompleteBanner product={product} />
        </div>
      ) : null}
      <div className="mb-3 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card">
        <div className="px-4 py-3">
          <p className="text-2xs font-medium tracking-wide text-faint uppercase">
            Units
          </p>
          <p className="mt-1 text-xl leading-7 font-semibold tracking-tight text-foreground tabular-nums">
            {quantityFormat.format(totals.totalQuantity)}
          </p>
        </div>
        <div className="border-l border-border px-4 py-3 text-right">
          <p className="text-2xs font-medium tracking-wide text-faint uppercase">
            Net sales
          </p>
          <p className="mt-1 text-xl leading-7 font-semibold tracking-tight text-foreground tabular-nums">
            {formatCents(totals.netSalesCents, product.currencyCode)}
          </p>
        </div>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table className="min-w-[520px] table-fixed">
          <TableHeader>
            <TableHeaderRow>
              <TableHead>Date</TableHead>
              <TableHead className="w-[160px]">Channel</TableHead>
              <TableHead className="w-[90px] text-right">Units</TableHead>
              <TableHead className="w-[120px] text-right">Sales</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    {dateLabel(row.soldOn)}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 text-base text-foreground">
                      {row.channel === "square" || row.channel === "shopify" ? (
                        <ChannelIcon channel={row.channel} />
                      ) : null}
                      {channelLabel(row.channel)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {quantityFormat.format(row.quantity)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.netSalesCents === null
                      ? "—"
                      : formatCents(
                          row.netSalesCents,
                          row.currencyCode || product.currencyCode
                        )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={4}>No sales in this period.</TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
      <BrowsePagination
        pagination={{
          page: current,
          limit: SALES_PAGE_SIZE,
          pages,
          total: all.length,
          next: current < pages ? current + 1 : null,
          prev: current > 1 ? current - 1 : null,
        }}
        onPageChange={setPage}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record sale</DialogTitle>
            <DialogDescription>
              Sales that did not come from a connected channel.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-6">
            <ManualSalesForm
              product={product}
              onRecorded={() => setOpen(false)}
            />
            <ManualSalesTable product={product} />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
