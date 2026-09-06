/**
 * Signed numbers, formatted the way the handoff prints them.
 *
 * `Intl` emits a hyphen-minus (U+002D) for negatives; the design draws a real
 * minus (U+2212), which is the same width as the plus and sits at the same
 * height, so a column of deltas lines up. Every screen went through its own
 * formatter in the first pass and none of them did this, which is why one
 * screen's "−1.4%" and another's "-1.4%" did not match.
 */

import { formatWholeCents } from "@/lib/money"

const MINUS = "−"

function withRealMinus(value: string) {
  return value.replace("-", MINUS)
}

const signedPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
})

const signedPoints = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
  signDisplay: "exceptZero",
})

/** `+8.4%` / `−2.4%` / `0.0%`, from a ratio (0.084). */
export function formatSignedPercent(ratio: number): string {
  return withRealMinus(signedPercent.format(ratio))
}

/** `+0.6 pt` — a move in something already measured in percent. */
export function formatSignedPoints(points: number): string {
  return `${withRealMinus(signedPoints.format(points))} pt`
}

/** `+$1,204` / `−$38` / `$0` — a money delta beside the figure it moved. */
export function formatSignedCents(cents: number, currencyCode = "USD"): string {
  const formatted = withRealMinus(formatWholeCents(cents, currencyCode))
  return cents > 0 ? `+${formatted}` : formatted
}
