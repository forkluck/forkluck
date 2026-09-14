/**
 * Signed numbers, formatted the way the handoff prints them.
 *
 * `Intl` emits a hyphen-minus (U+002D) for negatives; the design draws a real
 * minus (U+2212), which is the same width as the plus and sits at the same
 * height, so a column of deltas lines up. Every screen went through its own
 * formatter in the first pass and none of them did this, which is why one
 * screen's "−1.4%" and another's "-1.4%" did not match.
 */

import { formatCents, formatWholeCents } from "@/lib/money"

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

/** Whole money for summary cards; cents for exact cost comparisons. */
export function formatSignedCents(
  cents: number,
  currencyCode = "USD",
  precision: "whole" | "cents" = "whole"
): string {
  const amount = Math.round(cents) || 0
  const formatted = withRealMinus(
    precision === "cents"
      ? formatCents(amount, currencyCode)
      : formatWholeCents(amount, currencyCode)
  )
  return amount > 0 ? `+${formatted}` : formatted
}
