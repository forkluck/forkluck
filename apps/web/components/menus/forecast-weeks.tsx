import { units } from "@/components/menus/forecast-format"
import { SectionHeader } from "@/components/menus/forecast-tables"
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import type { MenuForecast } from "@/lib/backend/types"
import { formatCalendarDayMonth } from "@/lib/datetime"
import { cn } from "@/lib/utils"

/**
 * The menu's demand a week at a time: the eight weeks behind it, the same
 * weeks a year earlier, and the plan for the weeks ahead beside what those
 * weeks did last year. It is the baseline, the season and the shift in one
 * table, so a cook can see why the plan is the size it is before reading
 * a single product.
 */

const span = (start: string, end: string) =>
  `${formatCalendarDayMonth(start)}–${formatCalendarDayMonth(end)}`

/** A blank cell that still reads as a value, never as a missing render. */
const blank = <span className="text-faint">–</span>

/** The level and the season as two plain sentences from the basis. */
export function levelSentences(basis: MenuForecast["basis"]): string[] {
  const { level } = basis
  const recent = `Recent weeks point to about ${units(level.weeklyUnits)} menu items a week, recent weeks counting more.`
  if (level.seasonalProducts === 0) {
    return [
      recent,
      "No product has comparable history from last year, so nothing is scaled for the season.",
    ]
  }
  const count =
    level.seasonalProducts === 1
      ? "1 product is"
      : `${level.seasonalProducts} products are`
  const percent = Math.round(Math.abs(level.seasonalFactor - 1) * 100)
  if (percent === 0) {
    return [
      recent,
      `${count} scaled for the season, with no net change to the week overall.`,
    ]
  }
  const direction = level.seasonalFactor > 1 ? "up" : "down"
  return [
    recent,
    `Last year these dates ran ${direction === "up" ? "above" : "below"} the weeks before them, so ${count} scaled ${direction} by about ${percent}% overall.`,
  ]
}

export function DemandByWeek({ forecast }: { forecast: MenuForecast }) {
  const { weeks } = forecast.basis
  const sentences = levelSentences(forecast.basis)
  return (
    <section className="break-inside-avoid">
      <SectionHeader
        title="Demand by week"
        subtitle="Menu items sold in the last eight weeks, the same weeks last year, and the plan for the weeks ahead."
        badge={`Last ${weeks.recent.length} weeks and ahead`}
      />
      <TableFrame className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableHeaderRow>
              <TableHead className="min-w-40">Week</TableHead>
              <TableHead className="min-w-24 text-right">This year</TableHead>
              <TableHead className="min-w-24 text-right">Last year</TableHead>
              <TableHead className="min-w-24 text-right">Planned</TableHead>
            </TableHeaderRow>
          </TableHeader>
          <TableBody>
            {weeks.recent.map((week) => (
              <TableRow key={week.start}>
                <TableCell className="text-muted-foreground">
                  {span(week.start, week.end)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {units(week.units)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {units(week.lastYearUnits)}
                </TableCell>
                <TableCell className="text-right">{blank}</TableCell>
              </TableRow>
            ))}
            {weeks.horizon.map((week) => (
              <TableRow key={week.start} className="bg-fill-soft/60">
                <TableCell className="font-medium">
                  {span(week.start, week.end)}
                </TableCell>
                <TableCell className="text-right">{blank}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {units(week.lastYearUnits)}
                </TableCell>
                <TableCell
                  className={cn("text-right font-medium tabular-nums")}
                >
                  {units(week.plannedUnits)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
      <div className="mt-3 space-y-1 text-sm text-muted-foreground">
        {sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
    </section>
  )
}
