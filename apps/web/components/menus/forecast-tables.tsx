"use client"

import Link from "next/link"

import {
  ariaSort,
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
import type {
  MenuForecast as MenuForecastData,
  MenuForecastPlan,
} from "@/lib/backend/types"
import type { MeasurementSystem } from "@/lib/business-settings"
import { productHref } from "@/lib/product-href"
import { unitShort } from "@/lib/unit-registry"
import {
  displayWeight,
  toGrams,
  WEIGHT_UNITS,
  type WeightUnit,
} from "@/lib/units"
import { cn } from "@/lib/utils"

/**
 * The forecast page's tables. Product demand and Recipe batches sort on a
 * header click, the click-to-toggle the Products tables use, so a kitchen can
 * put its biggest sellers and its largest batches at the top. Ingredients and
 * supplies is not sortable; ingredients are listed before supplies.
 */

type ProductRow = MenuForecastData["products"][number]
type ProductSortKey = "product" | "typical" | "busy" | "history"
type RecipeRow = MenuForecastData["recipeRequirements"][number]
type RecipeSortKey = "recipe" | "batches"

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

/** Rows arrive A–Z from the backend and stay that way until a header is clicked. */
export function ProductForecastTable({
  forecast,
}: {
  forecast: MenuForecastData
}) {
  const busy = forecast.basis.plan === "busy"
  const { sort, toggle, directionFor } = useSortState<ProductSortKey>()
  const rows = sortRows<ProductRow, ProductSortKey>(forecast.products, sort, {
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
              <TableHead
                className="min-w-48"
                aria-sort={ariaSort(directionFor("product"))}
              >
                <SortHeader
                  direction={directionFor("product")}
                  onClick={() => toggle("product")}
                >
                  Product
                </SortHeader>
              </TableHead>
              <TableHead
                className={cn("min-w-24", !busy && "text-foreground")}
                aria-sort={ariaSort(directionFor("typical"))}
              >
                <SortHeader
                  align="right"
                  direction={directionFor("typical")}
                  onClick={() => toggle("typical")}
                >
                  Typical
                </SortHeader>
              </TableHead>
              <TableHead
                className={cn("min-w-24", busy && "text-foreground")}
                aria-sort={ariaSort(directionFor("busy"))}
              >
                <SortHeader
                  align="right"
                  direction={directionFor("busy")}
                  onClick={() => toggle("busy")}
                >
                  Busy
                </SortHeader>
              </TableHead>
              <TableHead
                className="min-w-32"
                aria-sort={ariaSort(directionFor("history"))}
              >
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

/**
 * Three digits a kitchen can act on: 981 g, 12.3 kg, 1.23 kg. Past a hundred a
 * fraction is noise on a forecast that is only good to a tenth or so of its
 * total, and the backend's thousandths never reach the screen.
 */
const amountFormats = [0, 1, 2].map(
  (digits) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits })
)

function amount(value: number) {
  return amountFormats[value >= 100 ? 0 : value >= 10 ? 1 : 2].format(value)
}

/**
 * A weight in the kitchen's own system, stepping up to the larger unit once
 * it gets there: 1,234 g reads 1.23 kg, and a thousand millilitres a litre.
 * Cups, cases and pieces are shown as they stand.
 */
function measure(quantity: number, unit: string, system: MeasurementSystem) {
  if (WEIGHT_UNITS.includes(unit as WeightUnit)) {
    const display = displayWeight(toGrams(quantity, unit as WeightUnit), system)
    return `${amount(display.amount)} ${display.unit}`
  }
  if (unit === "ml" || unit === "l") {
    const millilitres = unit === "l" ? quantity * 1000 : quantity
    const litres = millilitres >= 1000
    return `${amount(litres ? millilitres / 1000 : millilitres)} ${unitShort(litres ? "l" : "ml")}`
  }
  return `${amount(quantity)} ${unitShort(unit) || unit}`
}

function quantities(
  rows: Array<{ quantity: number; unit: string }>,
  system: MeasurementSystem
) {
  if (!rows.length) return "—"
  return rows.map((row) => measure(row.quantity, row.unit, system)).join(", ")
}

function planBadge(plan: MenuForecastPlan) {
  return plan === "busy" ? "Busy plan" : "Typical plan"
}

export function Requirements({
  forecast,
  measurementSystem,
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  const ingredients = forecast.materialRequirements.filter(
    (row) => row.kind === "ingredient"
  )
  const supplies = forecast.materialRequirements.filter(
    (row) => row.kind === "supply"
  )
  const badge = planBadge(forecast.basis.plan)
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
    <div className="grid gap-6 xl:grid-cols-2">
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold text-foreground">
            Recipe batches
          </h2>
          <Badge variant="secondary">{badge}</Badge>
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
                <TableHead aria-sort={ariaSort(directionFor("batches"))}>
                  <SortHeader
                    align="right"
                    direction={directionFor("batches")}
                    onClick={() => toggle("batches")}
                  >
                    Batches
                  </SortHeader>
                </TableHead>
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
                    <TableCell className="text-right tabular-nums">
                      {amount(row.batches)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableEmpty colSpan={2}>No recipe demand.</TableEmpty>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold text-foreground">
            Ingredients and supplies
          </h2>
          <Badge variant="secondary">{badge}</Badge>
        </div>
        <TableFrame className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableHeaderRow>
                <TableHead>Material</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Purchase units</TableHead>
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {[...ingredients, ...supplies].length ? (
                [...ingredients, ...supplies].map((row) => (
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
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {quantities(row.usage, measurementSystem)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {quantities(row.purchase, measurementSystem)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableEmpty colSpan={3}>No material demand.</TableEmpty>
              )}
            </TableBody>
          </Table>
        </TableFrame>
      </section>
    </div>
  )
}
