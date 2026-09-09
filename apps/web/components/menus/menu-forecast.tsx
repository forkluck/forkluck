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
import type { MenuForecast as MenuForecastData } from "@/lib/backend/types"
import type { MeasurementSystem } from "@/lib/business-settings"
import { parseDateKey } from "@/lib/date-presets"
import { formatDayMonth, formatFullDate } from "@/lib/datetime"

/** "Sep 8 to Sep 14, 2026": the year once, at the end. */
function horizonLabel(start: string, end: string) {
  return `${formatDayMonth(parseDateKey(start), "UTC")} to ${formatFullDate(parseDateKey(end), "UTC")}`
}

/** Method and scope stay beneath the operational tables. */
function ForecastBasis() {
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="w-fit cursor-pointer rounded-lg underline decoration-border underline-offset-4">
        How the forecast works
      </summary>
      <div className="mt-3 max-w-3xl space-y-2 leading-relaxed">
        <p>
          Each product uses its matching weekdays from the last eight weeks,
          with recent weeks counting more. Where last year has comparable
          records, part of its seasonal change adjusts expected demand. Open
          “Why this quantity?” beside a product to see its calculation and dated
          sales history.
        </p>
        <p>
          Busy adds an allowance for variation over the selected period. Day
          quantities distribute that allowance by weekday pattern; they are not
          separate daily risk estimates.
        </p>
        <p>
          Prep quantities use each product’s current recipes and yields. They do
          not subtract stock or food already prepared. Included products cover
          bundle contents and mapped modifiers; the chart and accuracy describe
          menu members only.
        </p>
        <p>
          Each menu is forecast independently. Adding forecasts from overlapping
          menus can count the same product twice.
        </p>
      </div>
    </details>
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
      <header>
        <h2 className="text-xl font-semibold tracking-tight">
          Production forecast
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Expected demand and the preparation it requires, before subtracting
          stock or food already prepared.
        </p>
      </header>

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
      <p
        className="text-xs text-muted-foreground"
        data-testid="forecast-money-caption"
      >
        {moneyCaption(forecast)}
      </p>
      <AnalyticsCard className="p-4 sm:p-6">
        <CardLabel className="mb-3">Menu demand by day</CardLabel>
        <MenuForecastChart
          series={forecast.series}
          horizonStart={horizonStart}
          plan={plan}
          summary={chartSummary(
            forecast.series,
            forecast.production,
            horizonStart
          )}
        />
        <CardNote className="mt-3">
          {accuracySentence(forecast.backtest)}
        </CardNote>
      </AnalyticsCard>
      <ForecastBasis />
    </ForecastControls>
  )
}
