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
  units,
  planColumns,
  buyLabel,
  isCountUnit,
  makes,
  measure,
  needed,
  packLabel,
  packsToBuy,
  usageNote,
} from "@/components/menus/forecast-format"
import type { ForecastView } from "@/components/menus/forecast-controls"
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
import { formatWholeCents } from "@/lib/money"
import { productHref } from "@/lib/product-href"
import { cn } from "@/lib/utils"

/**
 * The forecast page's tables. Every one sorts on a header click, the
 * click-to-toggle the Products tables use, so a kitchen can put its biggest
 * sellers, its largest batches and its dearest materials at the top.
 */

type ProductRow = MenuForecastData["products"][number]
type ProductSortKey = "product" | "typical" | "busy" | "history"
type RecipeRow = MenuForecastData["recipeRequirements"][number]
type RecipeSortKey = "recipe" | "batches"
type MaterialRow = MenuForecastData["materialRequirements"][number]
type MaterialSortKey = "material" | "buy" | "cost"

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
  view = "week",
}: {
  forecast: MenuForecastData
  view?: ForecastView
}) {
  const busy = forecast.basis.plan === "busy"
  const columns = view === "day" ? planColumns(forecast) : []
  const { sort, toggle, directionFor } = useSortState<ProductSortKey>()
  const rows = sortRows<ProductRow, ProductSortKey>(forecast.products, sort, {
    product: (row) => row.productName,
    typical: (row) => row.typicalQuantity,
    busy: (row) => row.busyQuantity,
    history: (row) => row.weeksObserved,
  })
  const header = (
    key: ProductSortKey,
    label: string,
    align: "left" | "right" = "left"
  ) => (
    <TableHead
      className={align === "right" ? "min-w-24" : "min-w-32"}
      aria-sort={ariaSort(directionFor(key))}
    >
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
      <SectionHeader
        title="Product demand"
        subtitle={
          view === "day"
            ? `The ${planWord(forecast.basis.plan)} plan, spread by weekday rhythm${forecast.basis.horizonDays === 30 ? " and grouped by week" : ""}.`
            : "Weekday-matched from the last eight weeks, summed over the horizon."
        }
        badge={`${forecast.coverage.productsWithHistory} of ${forecast.coverage.products} with history`}
      />
      <TableFrame className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              {header("product", "Product")}
              {view === "day" ? (
                <>
                  {columns.map((column) => (
                    <TableHead
                      key={column.start}
                      className="min-w-24 text-right"
                    >
                      {column.label}
                    </TableHead>
                  ))}
                  {header(busy ? "busy" : "typical", "Total", "right")}
                </>
              ) : (
                <>
                  {header("typical", "Typical", "right")}
                  {header("busy", "Busy", "right")}
                </>
              )}
              {header("history", "History")}
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((product) => (
                <TableRow key={product.productId}>
                  <TableCell>
                    <Link
                      href={productHref({ publicId: product.productPublicId })}
                      className="font-medium text-foreground hover:underline"
                    >
                      {product.productName}
                    </Link>
                    {!product.menuMember ? (
                      <Badge variant="secondary" className="ml-2">
                        Included
                      </Badge>
                    ) : null}
                    {!product.isActive ? (
                      <Badge variant="secondary" className="ml-2">
                        Inactive
                      </Badge>
                    ) : null}
                  </TableCell>
                  {view === "day" ? (
                    <>
                      {columns.map((column) => (
                        <TableCell
                          key={column.start}
                          className="text-right tabular-nums"
                        >
                          {units(
                            product.days
                              .filter(
                                (day) =>
                                  day.date >= column.start &&
                                  day.date <= column.end
                              )
                              .reduce(
                                (sum, day) => sum + day.plannedQuantity,
                                0
                              )
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-medium tabular-nums">
                        {units(product.totalQuantity)}
                      </TableCell>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                  <TableCell
                    className={cn(
                      "text-sm",
                      product.weeksObserved === 8
                        ? "text-faint"
                        : "text-muted-foreground"
                    )}
                  >
                    {historyLabel(product.weeksObserved)}
                    {product.seasonalFactor !== 1
                      ? ` · seasonal ${product.seasonalFactor.toFixed(2)}`
                      : ""}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={view === "day" ? columns.length + 3 : 4}>
                Link Products to this Menu to forecast demand.
              </TableEmpty>
            )}
          </TableBody>
        </Table>
      </TableFrame>
    </section>
  )
}

function planWord(plan: MenuForecastPlan) {
  return plan === "busy" ? "busy" : "typical"
}

/**
 * A section's title, its one-line subtitle and the count at the right, the
 * same shape over each of the page's tables so the eye reads three alike.
 */
function SectionHeader({
  title,
  subtitle,
  badge,
}: {
  title: string
  subtitle: string
  badge: string
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Badge variant="secondary">{badge}</Badge>
    </div>
  )
}

/** What the batches make, so 422 batches of a one-piece recipe reads as 422 pieces. */
function Makes({ row, system }: { row: RecipeRow; system: MeasurementSystem }) {
  const made = makes(row)
  if (!made) return <span className="text-faint">No yield</span>
  // A recipe that makes one piece a batch has nothing to add under the count.
  const onePiece = row.yieldAmount === 1 && isCountUnit(made.unit)
  return (
    <>
      {measure(made.quantity, made.unit, system)}
      {onePiece ? null : (
        <div className="text-xs text-faint">
          {measure(row.yieldAmount!, made.unit, system)} per batch
        </div>
      )}
    </>
  )
}

export function RecipeBatchesTable({
  forecast,
  measurementSystem,
  view = "week",
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
  view?: ForecastView
}) {
  const columns = view === "day" ? planColumns(forecast) : []
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
      <SectionHeader
        title="Recipe batches"
        subtitle={`Batches to make for the ${planWord(forecast.basis.plan)} plan, and what they yield.`}
        badge={`${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}`}
      />
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
              {columns.map((column) => (
                <TableHead key={column.start} className="min-w-24 text-right">
                  {column.label}
                </TableHead>
              ))}
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
                  {columns.map((column) => (
                    <TableCell
                      key={column.start}
                      className="text-right tabular-nums"
                    >
                      {amount(
                        row.days
                          .filter(
                            (day) =>
                              day.date >= column.start && day.date <= column.end
                          )
                          .reduce((sum, day) => sum + day.batches, 0)
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">
                    {amount(row.batches)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Makes row={row} system={measurementSystem} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableEmpty colSpan={3 + columns.length}>
                No recipe demand.
              </TableEmpty>
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
      {buyLabel(row, packs)}
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
      <SectionHeader
        title="Ingredients and supplies"
        subtitle={`What to buy for the ${planWord(forecast.basis.plan)} plan, in the packs the kitchen orders.`}
        badge={`${rows.length} ${rows.length === 1 ? "material" : "materials"}`}
      />
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
                      {packLabel(row) ?? blank}
                      {row.supplierPack ? (
                        <span className="text-faint">
                          {" "}
                          · {row.supplierPack.supplier}
                        </span>
                      ) : null}
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
  view = "week",
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
  view?: ForecastView
}) {
  return (
    <>
      <RecipeBatchesTable
        forecast={forecast}
        view={view}
        measurementSystem={measurementSystem}
      />
      <MaterialsTable
        forecast={forecast}
        measurementSystem={measurementSystem}
      />
    </>
  )
}
