import { formatDecimalHours } from "../../components/labor/labor-format"
import { formatCalendarDayMonth } from "@/lib/datetime"

export type OvertimeWeek = {
  weekStart: string
  totalSeconds: number
}

/**
 * One line of an overtime tooltip: `Week of Aug 9: 43.5`. The week start is
 * a date-only string, printed as the calendar date it is, so no local offset
 * can slide it onto the day before.
 */
export function overtimeWeekLine(week: OvertimeWeek): string {
  const label = formatCalendarDayMonth(week.weekStart)
  return `Week of ${label}: ${formatDecimalHours(week.totalSeconds)}`
}
