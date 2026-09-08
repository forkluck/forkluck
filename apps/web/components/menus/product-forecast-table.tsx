"use client"

import Link from "next/link"

import {
  SortHeader,
  sortRows,
  useSortState,
} from "@/components/menu/product-cells"
import { Badge } from "@/components/ui/badge"
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
import type { MenuForecast as MenuForecastData } from "@/lib/backend/types"
import { productHref } from "@/lib/product-href"
import { cn } from "@/lib/utils"

type ProductRow = MenuForecastData["products"][number]
type SortKey = "product" | "typical" | "busy" | "history"

/**
 * Whole units. A projection is good to a tenth or so of its total, never to a
 * thousandth of a cookie, and the kitchen bakes 13, not 12.965. Demand that
 * rounds to nothing but is not nothing prints as "<1", so a product that
 * sells some weeks does not read as one that never sells.
 */
const wholeUnitFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

function units(quantity: number) {
  if (quantity > 0 && quantity < 0.5) return "<1"
  return wholeUnitFormat.format(quantity)
}

function historyLabel(weeksObserved: number) {
  return weeksObserved
    ? `${weeksObserved} of 8 weeks`
    : "No sales in the last 8 weeks"
}

/**
 * Product demand. Rows arrive A–Z from the backend and stay that way until a
 * header is clicked; the click-to-toggle sort is the one the Products tables
 * use, so a kitchen can put its biggest sellers at the top of the list.
 */
export function ProductForecastTable({
  forecast,
}: {
  forecast: MenuForecastData
}) {
  const busy = forecast.basis.plan === "busy"
  const { sort, toggle, directionFor } = useSortState<SortKey>()
  const rows = sortRows<ProductRow, SortKey>(forecast.products, sort, {
    product: (row) => row.productName,
    typical: (row) => row.typicalQuantity,
    busy: (row) => row.busyQuantity,
    history: (row) => row.weeksObserved,
  })
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Product demand
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Weekday-matched from the last eight weeks, summed over the horizon.
          </p>
        </div>
        <Badge variant="secondary">
          {forecast.coverage.productsWithHistory} of{" "}
          {forecast.coverage.products} with history
        </Badge>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead className="min-w-48">
                <SortHeader
                  direction={directionFor("product")}
                  onClick={() => toggle("product")}
                >
                  Product
                </SortHeader>
              </TableHead>
              <TableHead className={cn("min-w-24", !busy && "text-foreground")}>
                <SortHeader
                  align="right"
                  direction={directionFor("typical")}
                  onClick={() => toggle("typical")}
                >
                  Typical
                </SortHeader>
              </TableHead>
              <TableHead className={cn("min-w-24", busy && "text-foreground")}>
                <SortHeader
                  align="right"
                  direction={directionFor("busy")}
                  onClick={() => toggle("busy")}
                >
                  Busy
                </SortHeader>
              </TableHead>
              <TableHead className="min-w-32">
                <SortHeader
                  direction={directionFor("history")}
                  onClick={() => toggle("history")}
                >
                  History
                </SortHeader>
              </TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((product) => (
                <TableRow key={product.productId}>
                  <TableCell>
                    <Link
                      href={productHref({
                        publicId: product.productPublicId,
                      })}
                      className="font-medium text-foreground hover:underline"
                    >
                      {product.productName}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {!product.menuMember ? (
                        <Badge variant="secondary">Modifier</Badge>
                      ) : null}
                      {!product.isActive ? (
                        <Badge variant="secondary">Inactive</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      !busy && "font-medium"
                    )}
                  >
                    {units(product.typicalQuantity)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      busy && "font-medium"
                    )}
                  >
                    {units(product.busyQuantity)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {historyLabel(product.weeksObserved)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={4}>
                Link Products to this Menu to forecast demand.
              </TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}
