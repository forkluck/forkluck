/**
 * How many decimals a quantity shows on screen. From ten up a quantity is a
 * whole number: a scaled batch reads "2030 g", never "2030.333 g", whatever
 * table or sheet prints it. Under ten the caller's precision stands, so
 * "2.5 g" of salt or "1.234 kg" keep the digits a cook needs.
 */
export const WHOLE_NUMBER_FROM = 10

export function displayFractionDigits(
  amount: number,
  belowTen: number
): number {
  return Math.abs(amount) >= WHOLE_NUMBER_FROM ? 0 : belowTen
}

const formats = new Map<string, Intl.NumberFormat>()

/** A cached en-US formatter with the display precision for `amount`. */
export function amountFormat(
  amount: number,
  belowTen: number,
  options: { useGrouping?: boolean } = {}
): Intl.NumberFormat {
  const digits = displayFractionDigits(amount, belowTen)
  const key = `${digits}:${options.useGrouping === false ? "n" : "g"}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: digits,
      ...(options.useGrouping === false ? { useGrouping: false } : {}),
    })
    formats.set(key, format)
  }
  return format
}
