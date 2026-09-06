/** Number shapes the Labor screens share. */

/**
 * One shift, the way a time clock prints it: `8:15`, beside its clock-in and
 * clock-out. Totals use `formatDecimalHours` — `323:56` reads as `323.56`.
 * Rounding to whole minutes first keeps 59.6 minutes from printing as `:60`.
 */
export function formatWorkedHours(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}:${String(minutes).padStart(2, "0")}`
}

const decimalHoursFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export function decimalHours(seconds: number): number {
  return Math.max(0, seconds) / 3600
}

export function formatDecimalHours(seconds: number): string {
  return decimalHoursFormat.format(decimalHours(seconds))
}
