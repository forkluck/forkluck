import { formatDecimalHours } from "../../components/labor/labor-format"

export type OvertimeWeek = {
  weekStart: string
  totalSeconds: number
}

const weekStartFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})

/**
 * One line of an overtime tooltip: `Week of 9 Aug: 43.5`. The week start is a
 * date-only string, so it is read at noon UTC and printed in UTC — no local
 * offset can slide it onto the day before.
 */
export function overtimeWeekLine(week: OvertimeWeek): string {
  const label = weekStartFormat.format(new Date(`${week.weekStart}T12:00:00Z`))
  return `Week of ${label}: ${formatDecimalHours(week.totalSeconds)}`
}
