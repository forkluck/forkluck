import { ForecastControls } from "@/components/menus/forecast-controls"
import {
  accuracySentence,
  chartSummary,
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
import { formatWholeCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import { formatCalendarDate } from "@/lib/datetime"

const dateLabel = formatCalendarDate

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
