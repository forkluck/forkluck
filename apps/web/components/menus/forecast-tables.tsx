"use client"

import Link from "next/link"

import {
  ariaSort,
  SortHeader,
  sortRows,
  useSortState,
} from "@/components/menu/product-cells"
import {
  amount,
  makes,
  measure,
  needed,
  packsLabel,
  packsToBuy,
  usageNote,
} from "@/components/menus/forecast-format"
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
import type {
  MenuForecast as MenuForecastData,
  MenuForecastPlan,
} from "@/lib/backend/types"
import type { MeasurementSystem } from "@/lib/business-settings"
import { formatCents, formatWholeCents } from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { formatPackSize } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

/**
 * The forecast page's tables. Every one sorts on a header click, the
 * click-to-toggle the Products tables use, so a kitchen can put its biggest
 * sellers, its largest batches and its dearest materials at the top.
 */

type ProductRow = MenuForecastData["products"][number]
type ProductSortKey =
  "product" | "typical" | "busy" | "price" | "sales" | "history"
type RecipeRow = MenuForecastData["recipeRequirements"][number]
type RecipeSortKey = "recipe" | "batches"
type MaterialRow = MenuForecastData["materialRequirements"][number]
type MaterialSortKey = "material" | "buy" | "cost"

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

/** Only thin history is worth a word; a full eight weeks is the norm. */
function historyLabel(weeksObserved: number) {
  if (weeksObserved === 8) return "Full"
  return weeksObserved
    ? `${weeksObserved} of 8 weeks`
    : "No sales in the last 8 weeks"
}

/** A blank cell that still reads as a value, never as a missing render. */
const blank = <span className="text-faint">–</span>

/** Rows arrive A–Z from the backend and stay that way until a header is clicked. */
export function ProductForecastTable({
  forecast,
}: {
  forecast: MenuForecastData
}) {
  const busy = forecast.basis.plan === "busy"
  const currencyCode = forecast.revenue.currencyCode
  const planCents = (row: ProductRow) =>
    busy ? row.busyCents : row.typicalCents
  const { sort, toggle, directionFor } = useSortState<ProductSortKey>()
  const rows = sortRows<ProductRow, ProductSortKey>(forecast.products, sort, {
    product: (row) => row.productName,
    typical: (row) => row.typicalQuantity,
    busy: (row) => row.busyQuantity,
    price: (row) => row.priceCents ?? -1,
    sales: (row) => planCents(row) ?? -1,
    history: (row) => row.weeksObserved,
  })
  const header = (
    key: ProductSortKey,
    label: string,
    className?: string,
    align: "left" | "right" = "left"
  ) => (
    <TableHead className={className} aria-sort={ariaSort(directionFor(key))}>
      <SortHeader
        align={align}
        direction={directionFor(key)}
        onClick={() => toggle(key)}
      >
        {label}
      </SortHeader>
    </TableHead>
  )
  return (
    <section className="break-inside-avoid">
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
              {header("product", "Product", "min-w-48")}
              {header(
                "typical",
                "Typical",
                cn("min-w-24", !busy && "text-foreground"),
                "right"
              )}
              {header(
                "busy",
                "Busy",
                cn("min-w-24", busy && "text-foreground"),
                "right"
              )}
              {header("price", "Price", "min-w-24", "right")}
              {header("sales", "Projected sales", "min-w-32", "right")}
              {header("history", "History", "min-w-32")}
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((product) => {
                const cents = planCents(product)
                return (
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
                      {!product.menuMember ? (
                        <Badge variant="secondary" className="ml-2">
                          Modifier
                        </Badge>
                      ) : null}
                      {!product.isActive ? (
                        <Badge variant="secondary" className="ml-2">
                          Inactive
                        </Badge>
                      ) : null}
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
                    <TableCell className="text-right tabular-nums">
                      {product.priceCents !== null ? (
                        formatCents(product.priceCents, currencyCode)
                      ) : product.menuMember ? (
                        <Badge variant="warning">No price</Badge>
                      ) : (
                        blank
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {cents !== null
                        ? formatWholeCents(cents, currencyCode)
                        : blank}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-sm",
                        product.weeksObserved === 8
                          ? "text-faint"
                          : "text-muted-foreground"
                      )}
                    >
                      {historyLabel(product.weeksObserved)}
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableEmpty colSpan={6}>
                Link Products to this Menu to forecast demand.
              </TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}

function planBadge(plan: MenuForecastPlan) {
  return plan === "busy" ? "Busy plan" : "Typical plan"
}

/** What the batches make, so 422 batches of a one-piece recipe reads as 422 pieces. */
function Makes({ row, system }: { row: RecipeRow; system: MeasurementSystem }) {
  const made = makes(row)
  if (!made) return <span className="text-faint">No yield</span>
  return (
    <>
      {measure(made.quantity, made.unit, system)}
      <div className="text-xs text-faint">
        {measure(row.yieldAmount!, made.unit, system)} per batch
      </div>
    </>
  )
}

export function RecipeBatchesTable({
  forecast,
  measurementSystem,
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  // The backend lists recipes in id order, which means nothing to a cook, so
  // the table opens A to Z; a header click takes it from there.
  const { sort, toggle, directionFor } = useSortState<RecipeSortKey>({
    key: "recipe",
    direction: "asc",
  })
  const recipes = sortRows<RecipeRow, RecipeSortKey>(
    forecast.recipeRequirements,
    sort,
    { recipe: (row) => row.recipeTitle, batches: (row) => row.batches }
  )
  return (
    <section className="break-inside-avoid">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Recipe batches
        </h2>
        <Badge variant="secondary">{planBadge(forecast.basis.plan)}</Badge>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead aria-sort={ariaSort(directionFor("recipe"))}>
                <SortHeader
                  direction={directionFor("recipe")}
                  onClick={() => toggle("recipe")}
                >
                  Recipe
                </SortHeader>
              </TableHead>
              <TableHead
                className="min-w-24"
                aria-sort={ariaSort(directionFor("batches"))}
              >
                <SortHeader
                  align="right"
                  direction={directionFor("batches")}
                  onClick={() => toggle("batches")}
                >
                  Batches
                </SortHeader>
              </TableHead>
              <TableHead className="min-w-32 text-right">Makes</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {recipes.length ? (
              recipes.map((row) => (
                <TableRow key={row.recipeId}>
                  <TableCell>
                    <Link
                      href={`/recipes/${encodeURIComponent(row.recipePublicId)}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {row.recipeTitle}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {amount(row.batches)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Makes row={row} system={measurementSystem} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={3}>No recipe demand.</TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}

/** Whole packs, or the reason there is no count yet. */
function Buy({ row }: { row: MaterialRow }) {
  const packs = packsToBuy(row.packs)
  if (packs === null) {
    return (
      <span className="text-faint">
        {row.purchaseSize === null || !row.purchaseUnit ? "Set pack size" : "–"}
      </span>
    )
  }
  return (
    <span
      title={row.packs === packs ? undefined : `${amount(row.packs!)} packs`}
    >
      {packsLabel(packs)}
    </span>
  )
}

export function MaterialsTable({
  forecast,
  measurementSystem,
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  const currencyCode = forecast.revenue.currencyCode
  const { sort, toggle, directionFor } = useSortState<MaterialSortKey>({
    key: "material",
    direction: "asc",
  })
  // Ingredients before supplies whatever the sort: the shopping list is food
  // first, and a sort by cost orders each list, never shuffles them together.
  const ordered = (kind: MaterialRow["kind"]) =>
    sortRows<MaterialRow, MaterialSortKey>(
      forecast.materialRequirements.filter((row) => row.kind === kind),
      sort,
      {
        material: (row) => row.ingredientName,
        buy: (row) => row.packs ?? -1,
        cost: (row) => row.costCents ?? -1,
      }
    )
  const rows = [...ordered("ingredient"), ...ordered("supply")]
  const header = (
    key: MaterialSortKey,
    label: string,
    className?: string,
    align: "left" | "right" = "left"
  ) => (
    <TableHead className={className} aria-sort={ariaSort(directionFor(key))}>
      <SortHeader
        align={align}
        direction={directionFor(key)}
        onClick={() => toggle(key)}
      >
        {label}
      </SortHeader>
    </TableHead>
  )
  return (
    <section className="break-inside-avoid">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Ingredients and supplies
        </h2>
        <Badge variant="secondary">{planBadge(forecast.basis.plan)}</Badge>
      </div>
      <TableFrame className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              {header("material", "Material", "min-w-48")}
              <TableHead className="min-w-28 text-right">Needed</TableHead>
              {header("buy", "Buy", "min-w-28", "right")}
              <TableHead className="min-w-24 text-right">Pack</TableHead>
              {header("cost", "Cost", "min-w-24", "right")}
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => {
                const note = usageNote(row, measurementSystem)
                return (
                  <TableRow key={row.ingredientId}>
                    <TableCell>
                      <Link
                        href={`/ingredients/${encodeURIComponent(row.ingredientPublicId)}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {row.ingredientName}
                      </Link>
                      {row.kind === "supply" ? (
                        <Badge variant="secondary" className="ml-2">
                          Supply
                        </Badge>
                      ) : null}
                      {note ? (
                        <div className="mt-0.5 text-xs text-faint">{note}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {needed(row, measurementSystem)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      <Buy row={row} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatPackSize(
                        row.purchaseSize,
                        row.purchaseUnit,
                        measurementSystem
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.costCents !== null ? (
                        formatWholeCents(row.costCents, currencyCode)
                      ) : row.packs !== null ? (
                        <span className="text-faint">No price</span>
                      ) : (
                        blank
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableEmpty colSpan={5}>No material demand.</TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}

export function Requirements({
  forecast,
  measurementSystem,
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  return (
    <>
      <RecipeBatchesTable
        forecast={forecast}
        measurementSystem={measurementSystem}
      />
      <MaterialsTable
        forecast={forecast}
        measurementSystem={measurementSystem}
      />
    </>
  )
}
