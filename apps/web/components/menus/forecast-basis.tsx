import { ListCard, ListHeader } from "@/components/overview/analytics-cards"
import { units } from "@/components/menus/forecast-format"
import type { MenuForecast } from "@/lib/backend/types"
import { formatCalendarDayMonth } from "@/lib/datetime"

const columns =
  "grid grid-cols-[minmax(10rem,1fr)_repeat(3,minmax(5rem,0.6fr))] items-center gap-4"

export function BasisPanel({ forecast }: { forecast: MenuForecast }) {
  const { weeks, level } = forecast.basis
  const range = (start: string, end: string) =>
    `${formatCalendarDayMonth(start)}–${formatCalendarDayMonth(end)}`
  return (
    <ListCard title="The basis for this plan">
      <div className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          Recent level: about {units(level.weeklyUnits)} items a week, recent
          weeks counting more.
        </p>
        <p>
          {level.seasonalProducts
            ? `Last year’s matching weeks adjust ${level.seasonalProducts} ${level.seasonalProducts === 1 ? "product" : "products"} by about ${level.seasonalFactor.toFixed(2)} overall.`
            : "Last year’s comparison leaves the recent level unchanged."}
        </p>
      </div>
      <div
        className="overflow-x-auto pb-3"
        role="table"
        aria-label="Forecast basis"
      >
        <div className="min-w-[540px]">
          <ListHeader className={columns} role="row">
            <span role="columnheader">Week</span>
            <span role="columnheader" className="text-right">
              This year
            </span>
            <span role="columnheader" className="text-right">
              Last year
            </span>
            <span role="columnheader" className="text-right">
              Planned
            </span>
          </ListHeader>
          <div className="px-5" role="rowgroup">
            {weeks.recent.map((week) => (
              <div
                key={week.start}
                role="row"
                className={`${columns} min-h-11 border-b border-muted text-sm`}
              >
                <span role="rowheader">{range(week.start, week.end)}</span>
                <span role="cell" className="text-right tabular-nums">
                  {units(week.units)}
                </span>
                <span
                  role="cell"
                  className="text-right text-muted-foreground tabular-nums"
                >
                  {units(week.lastYearUnits)}
                </span>
                <span role="cell" className="text-right text-faint">
                  —
                </span>
              </div>
            ))}
            {weeks.horizon.map((week) => (
              <div
                key={week.start}
                role="row"
                className={`${columns} min-h-11 border-b border-muted text-sm last:border-0`}
              >
                <span role="rowheader" className="font-medium">
                  {range(week.start, week.end)}{" "}
                  <span className="text-xs text-muted-foreground">coming</span>
                </span>
                <span
                  role="cell"
                  className="text-right text-muted-foreground tabular-nums"
                >
                  {units(week.typicalUnits)}
                </span>
                <span
                  role="cell"
                  className="text-right text-muted-foreground tabular-nums"
                >
                  {units(week.lastYearUnits)}
                </span>
                <span
                  role="cell"
                  className="text-right font-medium tabular-nums"
                >
                  {units(week.plannedUnits)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="px-5 pb-4 text-xs text-faint">
        Menu-member items per dated block. Coming rows show typical and planned
        quantities; the final block may be shorter than a week. Last year is
        shifted 52 weeks so weekdays match.
      </p>
    </ListCard>
  )
}
