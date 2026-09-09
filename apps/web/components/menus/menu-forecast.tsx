import { ForecastActions } from "@/components/menus/forecast-actions"
import { ForecastControls } from "@/components/menus/forecast-controls"
import {
  accuracySentence,
  chartSummary,
  materialCostSentence,
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
import { formatWholeCents } from "@/lib/money"

/** "Sep 8 to Sep 14, 2026": the year once, at the end. */
function horizonLabel(start: string, end: string) {
  return `${formatDayMonth(parseDateKey(start), "UTC")} to ${formatFullDate(parseDateKey(end), "UTC")}`
}

function ProjectedSales({ forecast }: { forecast: MenuForecastData }) {
  const { revenue, basis } = forecast
  const busy = basis.plan === "busy"
  const otherPlan = busy
    ? `Typical plan ${formatWholeCents(revenue.typicalCents, revenue.currencyCode)}`
    : `Busy plan ${formatWholeCents(revenue.busyCents, revenue.currencyCode)}`
  const cost = materialCostSentence(forecast)
  return (
    <AnalyticsCard className="px-4 pt-[22px] pb-[18px] sm:px-6">
      <CardLabel>Projected sales</CardLabel>
      <p className="mt-2 text-4xl leading-none font-semibold tracking-[-0.03em] tabular-nums">
        {formatWholeCents(revenue.plannedCents, revenue.currencyCode)}
      </p>
      {revenue.pricedProducts === 0 ? (
        <>
          <CardNote className="mt-[26px] leading-[1.55]">
            No Product on this Menu has a price yet, so there is nothing to
            project in money. Add prices to see projected sales.
          </CardNote>
          {cost ? <CardNote className="mt-1">{cost}</CardNote> : null}
        </>
      ) : (
        <>
          <CardNote className="mt-2">{otherPlan}</CardNote>
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
          {cost ? <CardNote className="mt-1">{cost}</CardNote> : null}
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
          recent weeks counting more. Priced at current menu prices.
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
            half of the change since then, marked Seasonal above.
          </p>
          <p>
            Recipe batches and materials expand the chosen plan through the
            current composition of each Product. Packs are the pack size of the
            material at its purchase price. Nothing here subtracts what is
            already in stock.
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
}: {
  forecast: MenuForecastData
  measurementSystem: MeasurementSystem
}) {
  const base = `/menu/${encodeURIComponent(forecast.menu.publicId)}/forecast`
  const { horizonDays, plan, horizonStart, horizonEnd } = forecast.basis
  return (
    <div className="flex flex-col gap-6">
      <ForecastControls
        base={base}
        days={horizonDays}
        plan={plan}
        horizon={horizonLabel(horizonStart, horizonEnd)}
        actions={<ForecastActions forecast={forecast} />}
      >
        <ProjectedSales forecast={forecast} />
        <ForecastBasis forecast={forecast} />

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
