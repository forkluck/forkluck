import type { WeightUnit } from "@/lib/units"

export const MEASUREMENT_SYSTEMS = ["metric", "us"] as const
export type MeasurementSystem = (typeof MEASUREMENT_SYSTEMS)[number]

export const CURRENCY_OPTIONS = [
  { code: "USD", label: "US dollar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "British pound" },
  { code: "CAD", label: "Canadian dollar" },
] as const

export type CurrencyCode = (typeof CURRENCY_OPTIONS)[number]["code"]

/**
 * Whose labelling rules the kitchen works to. It decides which allergen tags
 * the screens lead with and how the label preview declares them: a US panel
 * carries a Contains line, a UK/EU list emphasises the allergen ingredients.
 */
export const LABEL_REGIONS = ["us", "eu"] as const
export type LabelRegion = (typeof LABEL_REGIONS)[number]
export const LABEL_REGION_LABELS: Record<LabelRegion, string> = {
  us: "United States",
  eu: "United Kingdom and EU",
}

/**
 * The zones the picker offers. A full IANA list is ~440 entries and there is
 * no searchable select to render it; these cover where kitchens actually are.
 * Any IANA name the backend accepts still round-trips — the picker is the
 * narrow surface, not the storage.
 */
export const TIMEZONE_OPTIONS = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Vancouver",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Amsterdam",
  "UTC",
] as const

export type BusinessSettings = {
  wagePerHourCents: number
  measurementSystem: MeasurementSystem
  currencyCode: CurrencyCode
  labelRegion: LabelRegion
  foodCostTarget: number
  overtimeWeeklyMinutes: number
  /**
   * What the employer pays on top of a wage, as a percent. A plain number so
   * it fits any country's payroll; `lib/payroll-tax.ts` only helps estimate
   * it for US kitchens. Zero is "never set" and leaves labor cost the wage.
   */
  payrollTaxPercent: number
  /**
   * Minutes deducted from a shift for every whole `unpaidBreakPerHours` it
   * runs. Zero is off, and off is the default: a timesheet's hours are the
   * truth until a kitchen says its shifts carry an unpaid break.
   */
  unpaidBreakMinutes: number
  unpaidBreakPerHours: number
  productMatching: boolean
  /** What an hour of paid time cost over the last 90 days; null with none. */
  payrollAverageRateCents: number | null
  /** The zone every timestamp renders in. Resolved server-side, never blank. */
  timezone: string
}

export const DEFAULT_FOOD_COST_TARGET = 0.3

export const DEFAULT_OVERTIME_WEEKLY_MINUTES = 2400

/** The block the auto-deduct rule counts in when a kitchen turns it on. */
export const DEFAULT_UNPAID_BREAK_PER_HOURS = 8

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  wagePerHourCents: 2000,
  measurementSystem: "metric",
  currencyCode: "USD",
  labelRegion: "us",
  foodCostTarget: DEFAULT_FOOD_COST_TARGET,
  overtimeWeeklyMinutes: DEFAULT_OVERTIME_WEEKLY_MINUTES,
  payrollTaxPercent: 0,
  unpaidBreakMinutes: 0,
  unpaidBreakPerHours: DEFAULT_UNPAID_BREAK_PER_HOURS,
  productMatching: true,
  payrollAverageRateCents: null,
  timezone: "UTC",
}

/**
 * Whether the workspace links unambiguous cross-channel SKU matches.
 *
 * `getBusinessSettings` is an unvalidated cast, so a payload predating this
 * key arrives as `undefined`. That has to read as on — the setting defaults on
 * server-side, and resolving it to off here would show every merchant a switch
 * that disagrees with what their workspace is actually doing.
 */
export function resolveProductMatching(value: unknown): boolean {
  return value === undefined || value === null ? true : value !== false
}

/** The compact symbol an amount input wears in the workspace currency. */
export function currencySymbol(currencyCode: CurrencyCode): string {
  const parts = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0)
  return parts.find((part) => part.type === "currency")?.value ?? currencyCode
}

export function resolveFoodCostTarget(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0.01 &&
    value <= 1
    ? value
    : DEFAULT_FOOD_COST_TARGET
}

export function resolveOvertimeWeeklyMinutes(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 60 &&
    value <= 10080
    ? value
    : DEFAULT_OVERTIME_WEEKLY_MINUTES
}

/**
 * `getBusinessSettings` is an unvalidated cast, so a payload predating this
 * key arrives as `undefined`, and a name this build cannot resolve would make
 * every formatter fall back to the runtime's own zone.
 */
export function resolveTimezone(value: unknown): string {
  if (typeof value !== "string" || !value) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
  } catch {
    return "UTC"
  }
  return value
}

export function preferredWeightUnit(
  measurementSystem: MeasurementSystem
): WeightUnit {
  return measurementSystem === "us" ? "lb" : "kg"
}

/**
 * `getBusinessSettings` is an unvalidated cast, so a payload predating these
 * keys arrives as `undefined`. All three resolve to "off", which is what a
 * workspace that has never opened the setting is actually doing — reading a
 * missing key as anything else would load a burden nobody chose onto their
 * labor cost.
 */
export function resolvePayrollTaxPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

export function resolveUnpaidBreakMinutes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0
}

export function resolveUnpaidBreakPerHours(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_UNPAID_BREAK_PER_HOURS
}
