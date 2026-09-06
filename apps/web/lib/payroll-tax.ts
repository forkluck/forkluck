/**
 * Estimating a US employer's payroll burden as one percent of payroll.
 *
 * The setting this feeds is a plain percentage and works anywhere — a kitchen
 * in Lisbon or Toronto types its own number and never opens this file. What
 * is US-specific, and genuinely hard to get right, is that half of the burden
 * is *capped*: FUTA is charged on the first $7,000 a person earns in a year
 * and state unemployment on the first $N, where N ranges from $7,000 to over
 * $78,000 depending on the state. So a headline "4.1% state UI" is nothing
 * like 4.1% of payroll. In New York, whose 2026 base is $17,600, a cook on
 * $44,000 a year is charged on 40% of their wages, and the 4.1% is really
 * 1.64%. Quoting the headline rate would overstate that kitchen's burden by
 * two and a half times — which is the whole reason this does the proration
 * rather than adding the rates up.
 *
 * Social Security and Medicare are not prorated here. Both are flat on every
 * dollar a kitchen wage is likely to reach: Medicare has no cap at all, and
 * Social Security's is far above a full-time hourly wage.
 *
 * Everything here is an editable starting point, never an authority. An
 * employer's own unemployment rate is assigned to them by their state and
 * depends on their claims history and industry, so the only correct source is
 * the rate notice they are sent each year. The estimate exists to save the
 * arithmetic, not to replace that notice.
 */

/** Employer-side federal rates. Flat, statutory, and the same in every state. */
export const US_FEDERAL = {
  /** Employer half of Social Security. */
  socialSecurityPercent: 6.2,
  /** Employer half of Medicare. Uncapped. */
  medicarePercent: 1.45,
  /** FUTA, net of the standard 5.4% state credit. */
  futaPercent: 0.6,
  futaWageBase: 7000,
} as const

export type StateUnemployment = {
  code: string
  name: string
  /** The state's new-employer contribution rate, all mandatory funds in. */
  newEmployerRatePercent: number
  /** Annual wages per employee the rate is charged on. */
  wageBase: number
  /** The year these two were published for. */
  year: number
}

/**
 * The states whose published figures we carry.
 *
 * One entry, because one is what could be sourced and verified. A table of
 * fifty guessed rates in a costing tool is worse than no table: it reads as
 * authoritative and is wrong in a direction nobody checks. Adding a state is
 * one row from that state's own rate schedule, and `OTHER_STATE` covers every
 * kitchen until its row exists.
 *
 * New York, 2026: the new-employer rate is 4.1% including the 0.075%
 * Re-employment Services Fund, on a taxable wage base of $17,600 — which rose
 * from $12,800 and now tracks 18% of the state average annual wage each
 * January.
 */
export const STATE_UNEMPLOYMENT: StateUnemployment[] = [
  {
    code: "NY",
    name: "New York",
    newEmployerRatePercent: 4.1,
    wageBase: 17600,
    year: 2026,
  },
]

/** The choice a kitchen makes when its state is not in the table above. */
export const OTHER_STATE = "other"

/** A full-time year, used to turn an hourly rate into an annual wage. */
export const FULL_TIME_HOURS_PER_YEAR = 2000

export type BurdenInputs = {
  /** The employer's state unemployment rate, as a percent. */
  stateRatePercent: number
  /** Annual wages per employee that rate is charged on. */
  stateWageBase: number
  /** What one employee earns in a year. */
  annualWage: number
}

export type BurdenBreakdown = {
  ficaPercent: number
  futaPercent: number
  stateUnemploymentPercent: number
  totalPercent: number
}

/**
 * What a capped tax costs as a percent of one employee's whole year.
 *
 * Below the base the cap never binds and the answer is the rate itself; above
 * it the charge stops while the wages keep going, so the share falls.
 */
function cappedPercent(
  ratePercent: number,
  wageBase: number,
  annualWage: number
): number {
  if (annualWage <= 0 || ratePercent <= 0 || wageBase <= 0) return 0
  return (ratePercent * Math.min(annualWage, wageBase)) / annualWage
}

/** The estimated employer burden, and the parts it is made of. */
export function estimateBurden({
  stateRatePercent,
  stateWageBase,
  annualWage,
}: BurdenInputs): BurdenBreakdown {
  const fica = US_FEDERAL.socialSecurityPercent + US_FEDERAL.medicarePercent
  const futa = cappedPercent(
    US_FEDERAL.futaPercent,
    US_FEDERAL.futaWageBase,
    annualWage
  )
  const stateUnemployment = cappedPercent(
    stateRatePercent,
    stateWageBase,
    annualWage
  )
  return {
    ficaPercent: fica,
    futaPercent: futa,
    stateUnemploymentPercent: stateUnemployment,
    // Rounded to the two decimals the setting stores, so the figure the
    // estimator shows is the figure that gets saved.
    totalPercent: Math.round((fica + futa + stateUnemployment) * 100) / 100,
  }
}

/**
 * What the auto-deduct rule takes off a shift, in seconds.
 *
 * Mirrors `unpaid_break_seconds_for` in the backend so the import preview and
 * the settings dialog can show the deduction before anything is saved. Whole
 * completed blocks only: a seven-hour shift loses nothing.
 */
export function unpaidBreakSeconds(
  paidSeconds: number,
  minutes: number,
  perHours: number
): number {
  if (minutes <= 0 || perHours <= 0) return 0
  const blockSeconds = perHours * 3600
  const blocks = Math.floor(paidSeconds / blockSeconds)
  return Math.min(blocks * minutes * 60, paidSeconds)
}
