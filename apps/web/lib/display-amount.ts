/**
 * How a quantity reads on screen. A quantity is a whole number unless its
 * ingredient is one a cook weighs to the tenth of a gram (see
 * precise-ingredients.ts), so a scaled batch prints "2,030 g" of stock and
 * "10.3 g" of salt. A quantity that would round away to nothing keeps two
 * significant digits instead: "0.4 g", never "0 g".
 */
const formats = new Map<string, Intl.NumberFormat>()

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options)
  let format = formats.get(key)
  if (!format) {
    format = new Intl.NumberFormat("en-US", options)
    formats.set(key, format)
  }
  return format
}

// Half-expand rounding, so anything under half of the last displayed place
// collapses to a zero quantity no matter how the digits are spelled.
export function roundsToZero(amount: number, decimals: number): boolean {
  return amount > 0 && amount < 0.5 * 10 ** -decimals
}

/** Under one, a quantity keeps two significant digits whatever its
 * ingredient: "0.25 tsp", "0.022 g", never "0 g" or "0.3 tsp". */
function keepsSignificantDigits(amount: number): boolean {
  return amount !== 0 && Math.abs(amount) < 1
}

/** A cached en-US formatter for `amount` at `decimals`, or the significant
 * digits that keep a small quantity readable. */
export function amountFormat(
  amount: number,
  decimals: number,
  options: { useGrouping?: boolean } = {}
): Intl.NumberFormat {
  const grouping = options.useGrouping === false ? { useGrouping: false } : {}
  return keepsSignificantDigits(amount)
    ? numberFormat({ maximumSignificantDigits: 2, ...grouping })
    : numberFormat({ maximumFractionDigits: decimals, ...grouping })
}

export function formatDisplayAmount(
  amount: number,
  decimals: number,
  options: { useGrouping?: boolean } = {}
): string {
  return amountFormat(amount, decimals, options).format(amount)
}

/** The rounded number itself, for an input the cook may edit. */
export function roundDisplayAmount(amount: number, decimals: number): number {
  if (keepsSignificantDigits(amount)) return Number(amount.toPrecision(2))
  const scale = 10 ** decimals
  return Math.round(amount * scale) / scale
}
