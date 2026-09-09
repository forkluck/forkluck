import { ForecastActions } from "@/components/menus/forecast-actions"
import {
  ForecastControls,
  type ForecastView,
} from "@/components/menus/forecast-controls"
import {
  accuracySentence,
  chartSummary,
  moneyCaption,
} from "@/components/menus/forecast-series"
import { MenuForecastChart } from "@/components/menus/menu-forecast-chart"
import {
  ProductForecastTable,
  Requirements,
} from "@/components/menus/forecast-tables"
import {
  AnalyticsCard,
  CardLabel,
  CardNote,
} from "@/components/overview/analytics-cards"
import { Badge } from "@/components/ui/badge"
import type { MenuForecast as MenuForecastData } from "@/lib/backend/types"
import type { MeasurementSystem } from "@/lib/business-settings"
import { parseDateKey } from "@/lib/date-presets"
import { formatDayMonth, formatFullDate } from "@/lib/datetime"
import { amount, units } from "@/components/menus/forecast-format"
import { BasisPanel } from "@/components/menus/forecast-basis"

/** "Sep 8 to Sep 14, 2026": the year once, at the end. */
function horizonLabel(start: string, end: string) {
  return `${formatDayMonth(parseDateKey(start), "UTC")} to ${formatFullDate(parseDateKey(end), "UTC")}`
}

function ProductionPlan({ forecast }: { forecast: MenuForecastData }) {
  const { production, basis } = forecast
  const busy = basis.plan === "busy"
  return (
    <AnalyticsCard className="px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end gap-x-12 gap-y-5">
        <div>
          <CardLabel>
            {basis.horizonDays === 7
              ? "To make this week"
              : "To make over the next 30 days"}
          </CardLabel>
          <p className="mt-2 text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
            {units(production.plannedUnits)}{" "}
            <span className="text-lg font-normal text-muted-foreground">
              items
            </span>
          </p>
          <CardNote className="mt-2">
            {production.productsPlanned} products to plan
          </CardNote>
        </div>
        <div>
          <CardLabel>Recipe batches</CardLabel>
          <p className="mt-2 text-3xl leading-none font-semibold tabular-nums">
            {amount(production.recipeBatches)}
          </p>
          <CardNote className="mt-2">
            across {forecast.recipeRequirements.length}{" "}
            {forecast.recipeRequirements.length === 1 ? "recipe" : "recipes"}
          </CardNote>
        </div>
      </div>
      <CardNote className="mt-5">
        {busy ? "Typical" : "Busy"} plan:{" "}
        {units(busy ? production.typicalUnits : production.busyUnits)} items
      </CardNote>
      <CardNote className="mt-1">
        {accuracySentence(forecast.backtest)}
      </CardNote>
      <div className="mt-6">
        <CardLabel className="mb-2">Menu items by day</CardLabel>
        <MenuForecastChart
          series={forecast.series}
          horizonStart={basis.horizonStart}
          plan={basis.plan}
          summary={chartSummary(
            forecast.series,
            production,
            basis.horizonStart
          )}
        />
      </div>
    </AnalyticsCard>
  )
}

/**
 * One line on where the numbers come from, with the method a click away.
 * The dates the forecast covers sit beside the pills that chose them.
 */
function ForecastBasis({ forecast }: { forecast: MenuForecastData }) {
  return (
    <div className="text-sm text-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>
          Each day is projected from the same weekday over the last 8 weeks,
          recent weeks counting more. The chosen total follows that rhythm in
          the day view.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">Current composition</Badge>
          {forecast.basis.seasonalAdjustment ? (
            <Badge variant="secondary">Seasonal</Badge>
          ) : null}
        </div>
      </div>
      <details className="group mt-2 text-xs print:hidden">
        <summary className="w-fit cursor-pointer list-none rounded-md border border-transparent underline decoration-border underline-offset-4 outline-none hover:text-foreground focus-visible:border-foreground [&::-webkit-details-marker]:hidden">
          How this is calculated
        </summary>
        <div className="mt-2 max-w-3xl space-y-1.5 leading-[1.55]">
          <p>
            Busy is the level history stayed under about nine weeks in ten,
            pooled over the whole horizon rather than summed from daily peaks. A
            product that sold in both matching windows last year is scaled by
            half the difference between those windows, marked Seasonal above.
            Day quantities divide the chosen total by its weekday pattern; they
            are a production schedule, not separate daily busy estimates. If the
            typical pattern is zero, a positive plan is divided evenly.
          </p>
          <p>
            Recipe batches and materials expand the chosen plan through the
            current composition of each Product. The production total includes
            bundle contents and mapped modifiers; the chart, basis and accuracy
            describe menu members only. A material is bought in the pack its
            preferred supplier sells, at that pack price. Nothing here subtracts
            what is already in stock.
          </p>
          <p>
            Each Menu receives a full independent forecast. Summing forecasts
            from multiple Menus can double-count the same Product demand.
          </p>
        </div>
      </details>
    </div>
  )
}

export function MenuForecast({
  forecast,
  measurementSystem,
  view = "week",
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
  view?: ForecastView
}) {
  const base = `/menu/${encodeURIComponent(forecast.menu.publicId)}/forecast`
  const { horizonDays, plan, horizonStart, horizonEnd } = forecast.basis
  return (
    <ForecastControls
      base={base}
      days={horizonDays}
      plan={plan}
      view={view}
      horizon={horizonLabel(horizonStart, horizonEnd)}
      actions={<ForecastActions forecast={forecast} />}
    >
      {/* The basis is the hero's caption, so it hangs 12px under the card
          rather than a full section apart from it. */}
      <div className="flex flex-col gap-3">
        <ProductionPlan forecast={forecast} />
        <p
          className="text-xs text-muted-foreground"
          data-testid="forecast-money-caption"
        >
          {moneyCaption(forecast)}
        </p>
      </div>

      <BasisPanel forecast={forecast} />
      <ForecastBasis forecast={forecast} />

      {forecast.coverage.unresolvedMenuItems > 0 ? (
        <div className="rounded-xl border border-border bg-fill-soft px-4 py-3 text-sm text-muted-foreground">
          {forecast.coverage.unresolvedMenuItems} Menu{" "}
          {forecast.coverage.unresolvedMenuItems === 1 ? "row is" : "rows are"}{" "}
          not linked and cannot be forecast.
        </div>
      ) : null}

      <ProductForecastTable forecast={forecast} view={view} />
      <Requirements
        forecast={forecast}
        measurementSystem={measurementSystem}
        view={view}
      />

      {forecast.unresolved.length ? (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-md font-semibold text-foreground">
            Unresolved demand paths
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These quantities need a yield, conversion, purchase unit, or Product
            link before they can be completed.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            {forecast.unresolved.map((row, index) => (
              <li
                key={`${row.code}:${row.path?.join(":") ?? row.menuItemId ?? index}`}
              >
                <span className="font-medium text-foreground">{row.code}</span>
                {row.menuItemName ? ` · ${row.menuItemName}` : ""}
                {row.detail ? ` · ${row.detail}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </ForecastControls>
  )
}
