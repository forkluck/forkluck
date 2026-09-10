"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import { units } from "@/components/menus/forecast-format"
import type { MenuForecast } from "@/lib/backend/types"
import { formatCalendarDate } from "@/lib/datetime"

type Product = MenuForecast["products"][number]
type Week = Product["basis"]["recentWeeks"][number]
/** Whole units throughout: the panel explains what the table shows. */
const quantity = { format: (value: number) => units(value) }
/** A change in whole units with its sign, and "none" for one that rounds away. */
function signedUnits(value: number) {
  const whole = Math.round(value)
  if (whole === 0) return "none"
  return `${whole > 0 ? "+" : "−"}${units(Math.abs(whole))} units`
}
const dates = (row: { start: string; end: string }) =>
  `${formatCalendarDate(row.start)}–${formatCalendarDate(row.end)}`

function RecordedSales({ title, weeks }: { title: string; weeks: Week[] }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <Table aria-label={title}>
        <TableHeader>
          <TableHeaderRow>
            <TableHead>Dates</TableHead>
            <TableHead className="text-right">Recorded units</TableHead>
          </TableHeaderRow>
        </TableHeader>
        <TableBody>
          {weeks.map((week) => (
            <TableRow key={week.start}>
              <TableCell>{dates(week)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {quantity.format(week.quantity)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ProductForecastBasis({
  product,
  forecast,
}: {
  product: Product
  forecast: MenuForecast
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const { basis } = product
  const busy = forecast.basis.plan === "busy"
  const adjustment = basis.seasonalAdjustment
  return (
    <section
      aria-label={`Why this quantity for ${product.productName}`}
      className="space-y-4 py-2 text-sm"
    >
      <div>
        <h3 className="font-medium">
          {product.productName} ·{" "}
          {dates({
            start: forecast.basis.horizonStart,
            end: forecast.basis.horizonEnd,
          })}
        </h3>
        <p className="mt-1 text-muted-foreground">
          These figures cover the full selected period. Recent matching weekdays
          count more.
        </p>
      </div>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Recent demand suggests</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {quantity.format(basis.recentQuantity)} units
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Seasonal change</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {signedUnits(adjustment)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expected demand</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {quantity.format(product.typicalQuantity)} units
          </dd>
        </div>
        {busy ? (
          <div>
            <dt className="text-muted-foreground">Busy allowance</dt>
            <dd className="mt-1 font-medium tabular-nums">
              +{quantity.format(basis.busyAllowance)} units ·{" "}
              {quantity.format(product.totalQuantity)} in total
            </dd>
          </div>
        ) : null}
      </dl>
      {product.weeksObserved < 8 ? (
        <p className="text-muted-foreground">
          {product.weeksObserved
            ? `Limited history: records in ${product.weeksObserved} of the last 8 weeks.`
            : "No recent sales records. Zero is not evidence that there will be no demand."}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {basis.lastYearComparable
          ? "The seasonal change uses last year’s matching period compared with the eight weeks before it. Only part of that change is applied, with limits on large changes."
          : "Not enough comparable last-year history; no seasonal change is applied."}
      </p>
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={historyOpen}
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        {historyOpen ? "Hide sales history" : "View sales history"}
      </Button>
      {historyOpen ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <RecordedSales title="Recent sales" weeks={basis.recentWeeks} />
          <div className="space-y-4">
            <RecordedSales
              title="Last year: preceding eight weeks"
              weeks={basis.lastYearWeeks}
            />
            <RecordedSales
              title="Same period last year"
              weeks={[basis.lastYearPeriod]}
            />
            <p className="text-xs text-muted-foreground">
              Dates shift back 52 weeks so weekdays match. These are recorded
              units, not estimates; missing records do not prove zero demand.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
