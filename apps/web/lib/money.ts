/** How Forkluck prints money, quantities, and shares of a total. */

const currencyFormatters = new Map<string, Intl.NumberFormat>()

/** `null` for a currency code Intl rejects; the callers then print it plainly. */
function currencyFormatter(
  currencyCode: string,
  whole: boolean
): Intl.NumberFormat | null {
  const key = whole ? `${currencyCode} whole` : currencyCode
  let formatter = currencyFormatters.get(key)
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencyCode,
        ...(whole ? { maximumFractionDigits: 0 } : {}),
      })
    } catch (error) {
      // An unrecognised code is data, not a bug — do not take the screen down.
      if (!(error instanceof RangeError)) throw error
      return null
    }
    currencyFormatters.set(key, formatter)
  }
  return formatter
}

export function formatCents(cents: number, currencyCode = "USD"): string {
  const formatter = currencyFormatter(currencyCode, false)
  if (!formatter)
    return `${currencyCode} ${(Math.round(cents) / 100).toFixed(2)}`
  return formatter.format(Math.round(cents) / 100)
}

/**
 * Whole dollars, no cents: a 26px hero figure reads as "$3,905", never
 * "$3,905.00". `formatCents` stays the helper for exact figures — rows and
 * totals a user reconciles against.
 */
export function formatWholeCents(cents: number, currencyCode = "USD"): string {
  const formatter = currencyFormatter(currencyCode, true)
  if (!formatter) return `${currencyCode} ${Math.round(cents / 100)}`
  return formatter.format(Math.round(cents) / 100)
}

/**
 * Accepts what people actually type into a price field: "$3.46", "3.46",
 * "1,234.56". Anything that isn't a plain positive amount is rejected rather
 * than silently truncated — Number.parseFloat("1,234.56") is 1, not 1234.56.
 */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "")
  if (cleaned === "") return null
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100)
}

export function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** Units sold, which POS exports can report in fractions of an item. */
export const quantityFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
})

export const percentFormat = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
})
