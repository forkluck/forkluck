import Link from "next/link"

import { ForecastControls } from "@/components/menus/forecast-controls"
import {
  accuracySentence,
  chartSummary,
} from "@/components/menus/forecast-series"
import { MenuForecastChart } from "@/components/menus/menu-forecast-chart"
import {
  AnalyticsCard,
  CardLabel,
  CardNote,
} from "@/components/overview/analytics-cards"
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
import { unitShort } from "@/lib/unit-registry"
import {
  displayWeight,
  toGrams,
  WEIGHT_UNITS,
  type WeightUnit,
} from "@/lib/units"
import { cn } from "@/lib/utils"

const longDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
})

function dateLabel(value: string) {
  return longDate.format(new Date(`${value}T00:00:00Z`))
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

function planBadge(plan: MenuForecastPlan) {
  return plan === "busy" ? "Busy plan" : "Typical plan"
}

function ProjectedSales({ forecast }: { forecast: MenuForecastData }) {
  const { revenue, basis } = forecast
  const busy = basis.plan === "busy"
  return (
    <AnalyticsCard className="px-4 pt-[22px] pb-[18px] sm:px-6">
      <CardLabel>Projected sales</CardLabel>
      <p className="mt-2 text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {formatWholeCents(revenue.plannedCents, revenue.currencyCode)}
      </p>
      {revenue.pricedProducts === 0 ? (
        <CardNote className="mt-[26px] leading-[1.55]">
          No Product on this Menu has a price yet, so there is nothing to
          project in money. Add prices to see projected sales.
        </CardNote>
      ) : (
        <>
          <CardNote className="mt-2">
            <span className={cn(!busy && "font-medium text-foreground")}>
              typical{" "}
              {formatWholeCents(revenue.typicalCents, revenue.currencyCode)}
            </span>{" "}
            ·{" "}
            <span className={cn(busy && "font-medium text-foreground")}>
              busy {formatWholeCents(revenue.busyCents, revenue.currencyCode)}
            </span>
          </CardNote>
          {revenue.unpricedProducts > 0 ? (
            <CardNote className="mt-1">
              {revenue.unpricedProducts === 1
                ? "1 product has no price and is left out of the total."
                : `${revenue.unpricedProducts} products have no price and are left out of the total.`}
            </CardNote>
          ) : null}
          <CardNote className="mt-1">
            {accuracySentence(forecast.backtest)}
          </CardNote>
          <div className="mt-[26px]">
            <MenuForecastChart
              series={forecast.series}
              horizonStart={basis.horizonStart}
              currencyCode={revenue.currencyCode}
              summary={chartSummary(
                forecast.series,
                revenue,
                basis.horizonStart
              )}
            />
          </div>
        </>
      )}
    </AnalyticsCard>
  )
}

function ProductForecastTable({ forecast }: { forecast: MenuForecastData }) {
  const busy = forecast.basis.plan === "busy"
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
              <TableHead className="min-w-48">Product</TableHead>
              <TableHead
                className={cn(
                  "min-w-24 text-right",
                  !busy && "text-foreground"
                )}
              >
                Typical
              </TableHead>
              <TableHead
                className={cn("min-w-24 text-right", busy && "text-foreground")}
              >
                Busy
              </TableHead>
              <TableHead className="min-w-32">History</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {forecast.products.length ? (
              forecast.products.map((product) => (
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

function Requirements({
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
                <TableHead>Recipe</TableHead>
                <TableHead className="text-right">Batches</TableHead>
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {forecast.recipeRequirements.length ? (
                forecast.recipeRequirements.map((row) => (
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

export function MenuForecast({
  forecast,
  measurementSystem,
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  const base = `/menu/${encodeURIComponent(forecast.menu.publicId)}/forecast`
  const { horizonDays, plan } = forecast.basis
  return (
    <div className="flex flex-col gap-6">
      <ForecastControls base={base} days={horizonDays} plan={plan}>
        <ProjectedSales forecast={forecast} />

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-md font-semibold text-foreground">
                Forecast basis
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {dateLabel(forecast.basis.horizonStart)} –{" "}
                {dateLabel(forecast.basis.horizonEnd)}. Each day is projected
                from the same weekday over the last 8 weeks, recent weeks
                counting more. Busy is the level history stayed under about nine
                weeks in ten. Priced at current menu prices.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">Current composition</Badge>
              {forecast.basis.seasonalAdjustment ? (
                <Badge variant="secondary">Seasonal</Badge>
              ) : null}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Each Menu receives a full independent forecast. Summing forecasts
            from multiple Menus can double-count the same Product demand.
          </p>
        </div>

        {forecast.coverage.unresolvedMenuItems > 0 ? (
          <div className="rounded-xl border border-border bg-fill-soft px-4 py-3 text-sm text-muted-foreground">
            {forecast.coverage.unresolvedMenuItems} Menu{" "}
            {forecast.coverage.unresolvedMenuItems === 1
              ? "row is"
              : "rows are"}{" "}
            not linked and cannot be forecast.
          </div>
        ) : null}

        <ProductForecastTable forecast={forecast} />
        <div className="border-t-[6px] border-secondary" />
        <Requirements
          forecast={forecast}
          measurementSystem={measurementSystem}
        />

        {forecast.unresolved.length ? (
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-md font-semibold text-foreground">
              Unresolved demand paths
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              These quantities need a yield, conversion, purchase unit, or
              Product link before they can be completed.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
              {forecast.unresolved.map((row, index) => (
                <li
                  key={`${row.code}:${row.path?.join(":") ?? row.menuItemId ?? index}`}
                >
                  <span className="font-medium text-foreground">
                    {row.code}
                  </span>
                  {row.menuItemName ? ` · ${row.menuItemName}` : ""}
                  {row.detail ? ` · ${row.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </ForecastControls>
    </div>
  )
}
