"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Archive,
  ArchiveRestore,
  SquarePen,
  Trash2,
  Upload,
} from "lucide-react"

import { deleteMenuItem, saveSalesProduct } from "@/app/(app)/products/actions"
import { GuardedLink } from "@/components/navigation-blocker"
import {
  ChannelIcon,
  CountCell,
  CountRow,
  SkuCell,
  type SkuEntry,
} from "@/components/menu/product-cells"
import type { ProductStatusFilter } from "@/components/menu/types"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { buttonVariants } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DataTable,
  dataTableColumns,
  type DataTableRemote,
} from "@/components/ui/data-table"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { MenuItem } from "@/components/ui/menu"
import { EmptyState } from "@/components/ui/page"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { Spinner } from "@/components/ui/spinner"
import { useToast } from "@/components/ui/toast"
import { formatDayMonth } from "@/lib/datetime"
import type { SalesProductRow } from "@/lib/backend/types"
import { csvCell } from "@/lib/csv"
import { formatCents } from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { channelLabel } from "@/lib/sales-identity"
import { unitShort } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"

/**
 * Every catalog identity this product is sold under. A box is its own product
 * now, so a product inside one reaches the SKU, Channels and Variants columns
 * through the box's own row. Modifier identities belong to the Modifiers tab
 * and are not sellable variants.
 */
function itemVariants(row: SalesProductRow) {
  return row.variants.filter((variant) => variant.identityKind === "item")
}

/** A product whose composition names another product is a box. */
function isBundle(row: SalesProductRow) {
  return row.components.some((component) => component.productId !== null)
}

function itemSkuEntries(row: SalesProductRow): SkuEntry[] {
  // The product's own SKUs lead, own before packs; a variant sold under one
  // of them adds nothing the row does not already say.
  const own = row.skus.map((entry) => ({
    sku: entry.sku,
    label: row.name,
    detail: entry.quantityMultiplier === 1 ? "Product SKU" : "Pack SKU",
    multiplier: entry.quantityMultiplier,
  }))
  const ownSkus = new Set(own.map((entry) => entry.sku.toUpperCase()))
  // Keyed by channel as well as SKU: one number can name two different boxes,
  // one per channel, and they can hold different counts of this product.
  const seen = new Set<string>()
  const linked = itemVariants(row)
    .flatMap((variant) => {
      const sku = variant.sku.trim()
      const key = `${variant.channel}:${sku}`
      if (!sku || seen.has(key) || ownSkus.has(sku.toUpperCase())) return []
      seen.add(key)
      return [
        {
          sku,
          label: variant.externalName || sku,
          detail: [channelLabel(variant.channel), variant.externalVariantTitle]
            .filter(Boolean)
            .join(" · "),
          multiplier: variant.quantityMultiplier,
        },
      ]
    })
    .sort(
      (left, right) =>
        (left.multiplier === 1 ? 0 : 1) - (right.multiplier === 1 ? 0 : 1) ||
        left.sku.localeCompare(right.sku)
    )
  return [...own, ...linked]
}

function packSkus(row: SalesProductRow) {
  return row.skus
    .filter((entry) => entry.quantityMultiplier !== 1)
    .map((entry) => `${entry.sku} ×${entry.quantityMultiplier}`)
    .join("; ")
}

function itemChannels(row: SalesProductRow) {
  return [...new Set(itemVariants(row).map((variant) => variant.channel))]
}

/** Secondary cell: 13.5px `--muted-foreground`, one step under the name. */
function Cell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-base whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * The name alone. Every SKU the product answers to — its own, its packs', and
 * its variants' — is the SKU column's business, which can show all of them.
 */
function ProductNameCell({ product }: { product: SalesProductRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Link
        href={productHref(product)}
        className="truncate rounded-sm text-md text-foreground outline-none focus-visible:underline"
      >
        {product.name}
      </Link>
      {isBundle(product) ? (
        <Badge size="row" variant="secondary">
          Bundle
        </Badge>
      ) : null}
    </span>
  )
}

/** Price with the unit it is sold by appended, unless that unit is "each". */
function priceLabel(cents: number, baseUnit: string, currencyCode: string) {
  if (cents === 0) return "—"
  const price = formatCents(cents, currencyCode)
  return baseUnit && baseUnit !== "each"
    ? `${price} / ${unitShort(baseUnit)}`
    : price
}

const PRODUCT_CSV_HEADER = [
  "Product",
  "SKU",
  "Pack SKUs",
  "Category",
  "Channels",
  "Variants",
  "Price",
  "Status",
  "Updated",
]

/** One CSV row: money as a plain decimal, channels joined into one cell. */
function productCsvRow(product: SalesProductRow): string {
  return [
    csvCell(product.name, { alwaysQuote: true }),
    csvCell(product.sku),
    csvCell(packSkus(product)),
    csvCell(product.category),
    csvCell(itemChannels(product).map(channelLabel).join("; ")),
    itemVariants(product).length,
    (product.sellPriceCents / 100).toFixed(2),
    product.isActive ? "Active" : "Inactive",
    product.updatedAt.toISOString().slice(0, 10),
  ].join(",")
}

/** Client-side CSV download of the given rows. */
function exportProductsCsv(rows: SalesProductRow[]) {
  const lines = [PRODUCT_CSV_HEADER.join(","), ...rows.map(productCsvRow)]
  const blob = new Blob([lines.join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "products_export.csv"
  anchor.click()
  URL.revokeObjectURL(url)
}

const helper = dataTableColumns<SalesProductRow>()

/**
 * Products — the catalog table.
 *
 * The table shows one server page: search, sort and the Status pill all travel
 * in the URL, so a merchant with a few thousand SKUs pays for fifty rows.
 * Selection therefore covers the current page, the same bargain the
 * Ingredients browser makes. It carries no sales figures; per-product revenue
 * lives on the Menu page and each product's own page.
 */
export function ProductsTable({
  rows,
  hasAnyProduct,
  status,
  onStatusChange,
  posConnected = true,
  remote,
  footer,
}: {
  rows: SalesProductRow[]
  /** Unfiltered existence: "nothing matched" against "nothing yet". */
  hasAnyProduct: boolean
  status: ProductStatusFilter | null
  onStatusChange?: (value: string | null) => void
  /** False when neither Square nor Shopify is linked. */
  posConnected?: boolean
  remote?: DataTableRemote
  footer?: React.ReactNode
}) {
  const { currencyCode, timezone } = useBusinessSettings()
  const router = useRouter()
  const { refresh } = useRefresh()
  const toast = useToast()
  const [deleteTarget, setDeleteTarget] =
    React.useState<SalesProductRow | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const runDelete = async (target: SalesProductRow) => {
    setPending(true)
    setError(null)
    const result = await deleteMenuItem(target.id)
    setPending(false)
    if ("error" in result) {
      setError(result.error)
      return
    }
    setDeleteTarget(null)
  }

  // Archiving is the product page's Active switch, off: the product leaves
  // the active list but stays in historical sales.
  const setActive = React.useCallback(
    async (products: SalesProductRow[], isActive: boolean) => {
      for (const product of products) {
        const result = await saveSalesProduct({
          id: product.publicId,
          expectedEditVersion: product.editVersion,
          isActive,
        })
        if ("error" in result) {
          setError(result.error)
          return false
        }
      }
      return true
    },
    []
  )
  // The menu that asked has closed, so the row shows the wait and a toast
  // says what happened once the refreshed list agrees.
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const archive = React.useCallback(
    async (products: SalesProductRow[], isActive: boolean) => {
      if (products.length === 1) setBusyId(products[0].id)
      try {
        const ok = await setActive(products, isActive)
        if (!ok) return false
        await refresh()
        toast.add({
          title: `${isActive ? "Restored" : "Archived"} ${
            products.length === 1
              ? products[0].name
              : `${products.length} products`
          }`,
        })
        return true
      } finally {
        setBusyId(null)
      }
    },
    [refresh, setActive, toast]
  )

  const rowActions = React.useCallback(
    (product: SalesProductRow) =>
      busyId === product.id ? (
        <Spinner size="sm" label="Saving" className="size-8" />
      ) : (
        <RowActionsMenu
          label={`Actions for ${product.name}`}
          className="w-[172px]"
        >
          <MenuItem onClick={() => router.push(productHref(product))}>
            <SquarePen strokeWidth={1.8} aria-hidden="true" />
            Edit product
          </MenuItem>
          {product.isActive ? (
            <MenuItem onClick={() => void archive([product], false)}>
              <Archive strokeWidth={1.8} aria-hidden="true" />
              Archive product
            </MenuItem>
          ) : (
            <MenuItem onClick={() => void archive([product], true)}>
              <ArchiveRestore strokeWidth={1.8} aria-hidden="true" />
              Restore product
            </MenuItem>
          )}
          <MenuItem
            className="text-destructive data-highlighted:text-destructive"
            onClick={() => setDeleteTarget(product)}
          >
            <Trash2 strokeWidth={1.8} aria-hidden="true" />
            Delete
          </MenuItem>
        </RowActionsMenu>
      ),
    [archive, busyId, router]
  )

  const columns = React.useMemo(
    () => [
      helper.accessor((row) => row.name, {
        id: "product",
        header: "Product",
        // The row's identity — hiding it would leave nameless rows.
        enableHiding: false,
        meta: { className: "max-w-0", minWidth: 240 },
        cell: ({ row }) => <ProductNameCell product={row.original} />,
      }),
      helper.accessor((row) => row.category, {
        id: "category",
        header: "Category",
        meta: { className: "w-[14%] max-w-0", minWidth: 120 },
        cell: ({ row }) => <Cell>{row.original.category || "—"}</Cell>,
      }),
      helper.display({
        id: "sku",
        header: "SKU",
        meta: { className: "w-[14%] max-w-0", minWidth: 120 },
        cell: ({ row }) => <SkuCell entries={itemSkuEntries(row.original)} />,
      }),
      helper.display({
        id: "channels",
        header: "Channels",
        meta: { className: "w-[14%] max-w-0", minWidth: 120 },
        cell: ({ row }) => {
          const channels = itemChannels(row.original)
          return (
            <CountCell
              count={channels.length}
              label={["sales channel", "sales channels"]}
              width={160}
            >
              {channels.map((channel) => (
                <CountRow key={channel}>
                  <ChannelIcon channel={channel} />
                  {channelLabel(channel)}
                </CountRow>
              ))}
            </CountCell>
          )
        },
      }),
      helper.display({
        id: "variants",
        header: "Variants",
        meta: { className: "w-[11%]", minWidth: 100 },
        cell: ({ row }) => {
          const variants = itemVariants(row.original)
          return (
            <CountCell
              count={variants.length}
              label={["variant", "variants"]}
              width={260}
            >
              {variants.map((variant) => (
                <CountRow
                  key={variant.id}
                  detail={variant.sku.trim() || channelLabel(variant.channel)}
                >
                  {[variant.externalName, variant.externalVariantTitle]
                    .filter(Boolean)
                    .join(" · ")}
                </CountRow>
              ))}
            </CountCell>
          )
        },
      }),
      helper.accessor((row) => row.sellPriceCents, {
        id: "price",
        header: "Price",
        meta: { align: "right", className: "w-[12%]", minWidth: 110 },
        cell: ({ row }) => (
          <Cell>
            {priceLabel(
              row.original.sellPriceCents,
              row.original.baseUnit,
              currencyCode
            )}
          </Cell>
        ),
      }),
      helper.accessor((row) => row.isActive, {
        id: "status",
        header: "Status",
        meta: { align: "center", className: "w-[10%]", minWidth: 96 },
        cell: ({ row }) => (
          <Badge
            size="row"
            variant={row.original.isActive ? "success" : "secondary"}
          >
            {row.original.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      }),
      helper.accessor((row) => row.updatedAt.getTime(), {
        id: "updated",
        header: "Updated",
        meta: { align: "right", className: "w-[11%]", minWidth: 110 },
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
    [currencyCode, rowActions, timezone]
  )

  const segmentFilters = React.useMemo(
    () => [
      {
        label: "Status",
        options: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ],
        getValue: (row: SalesProductRow) =>
          row.isActive ? "active" : "inactive",
        value: status,
        onValueChange: (value: string | null) => onStatusChange?.(value),
      },
    ],
    [onStatusChange, status]
  )

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-base text-destructive">
          {error}
        </p>
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        enableSelection
        selectColumnClassName="w-[26px] pr-0"
        tableClassName="table-fixed"
        searchPlaceholder="Search products"
        remote={remote}
        footer={footer}
        columnsMenu={{
          storageKey: "products",
          defaultHidden: ["updated"],
          headerColumnId: "actions",
        }}
        emptyMessage={
          hasAnyProduct
            ? "No products match that filter."
            : "No products yet. Add one, or link a product from Catalog."
        }
        tableReplacement={
          hasAnyProduct || posConnected ? undefined : (
            // The one empty card every other list draws, not a bare row.
            <EmptyState
              title="No products yet"
              description="Products come from your Square or Shopify catalog. Connect a channel to pull them in, or add one by hand."
            >
              <GuardedLink
                href="/integrations/sales/connections"
                className={cn(buttonVariants())}
              >
                Connect a channel
              </GuardedLink>
              <GuardedLink
                href="/products/new"
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Add product
              </GuardedLink>
            </EmptyState>
          )
        }
        segmentFilters={segmentFilters}
        onRowClick={(row) => router.push(productHref(row))}
        bulkActions={({ rows: selected, clear }) => (
          <BulkDeleteMenu
            count={selected.length}
            noun="product"
            description="Their mappings are removed. Recorded sales move to Catalog and stay out of reports until you track them again."
            onDelete={async () => {
              for (const product of selected) {
                const result = await deleteMenuItem(product.id)
                if ("error" in result) throw new Error(result.error)
              }
              clear()
            }}
          >
            <MenuItem
              onClick={async () => {
                if (await archive(selected, false)) clear()
              }}
            >
              <Archive strokeWidth={1.8} aria-hidden="true" />
              Archive {selected.length === 1 ? "product" : "products"}
            </MenuItem>
          </BulkDeleteMenu>
        )}
        toolbarExtra={({ selectedRows }) => (
          <>
            <ActionsMenu>
              <MenuItem
                onClick={() =>
                  exportProductsCsv(selectedRows.length ? selectedRows : rows)
                }
              >
                <Upload strokeWidth={1.8} aria-hidden="true" />
                {selectedRows.length
                  ? `Export ${selectedRows.length} product${
                      selectedRows.length === 1 ? "" : "s"
                    }`
                  : "Export products"}
              </MenuItem>
            </ActionsMenu>
            <GuardedLink
              href="/products/new"
              className={cn(buttonVariants(), "shrink-0")}
            >
              Add product
            </GuardedLink>
          </>
        )}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleteTarget(null)
        }}
        title="Delete this product?"
        description={
          <>
            {deleteTarget?.name} and its mapping are removed. Sales already
            recorded move to Catalog and stay out of reports until you track
            them again.
          </>
        }
        confirmLabel={pending ? "Deleting…" : "Delete product"}
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) void runDelete(deleteTarget)
        }}
      />
    </>
  )
}
