/** What every chart on the app shares: a compact money axis and sparse ticks. */

const compactFormatters = new Map<string, Intl.NumberFormat | null>()

/** Axis ticks are read at a glance, so "$3.9K" beats "$3,905.00". */
export function formatAxisCents(cents: number, currencyCode: string): string {
  let formatter = compactFormatters.get(currencyCode)
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode,
        notation: "compact",
        // One decimal, or $1,800 rounds to "$2K" on the same axis as "$900".
        maximumFractionDigits: 1,
      })
    } catch (error) {
      // An unrecognised code is data, not a bug — do not take the chart down.
      if (!(error instanceof RangeError)) throw error
      formatter = null
    }
    compactFormatters.set(currencyCode, formatter)
  }
  if (!formatter) return `${currencyCode} ${Math.round(cents / 100)}`
  return formatter.format(Math.round(cents) / 100)
}

/** Above this the x-axis labels collide, so only every nth point keeps one. */
export const MAX_LABELS = 11

export function withLabelSteps<T>(
  points: T[]
): Array<T & { showLabel: boolean }> {
  const step = Math.max(1, Math.ceil(points.length / MAX_LABELS))
  return points.map((point, index) => ({
    ...point,
    showLabel: index % step === 0,
  }))
}
