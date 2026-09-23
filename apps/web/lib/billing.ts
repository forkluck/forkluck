import type { SessionPayload } from "@/lib/backend/schemas"

export type BillingState = SessionPayload["billing"]

/** "disabled" is billing switched off, not a lapse. */
export function billingLocked(billing: BillingState): boolean {
  return billing.locked
}

export function onTrial(billing: BillingState): boolean {
  return billing.plan === "trial"
}

/** The plan after the trial, and after a subscription ends: recipes,
 * ingredients, costing and nutrition keep working, and operations wait on a
 * subscription. The backend refuses those writes; this only shapes copy. */
export function onFreePlan(billing: BillingState): boolean {
  return billing.plan === "free"
}

/** The sections a free account reads but cannot write in. Prefix on a path
 * segment, so `/menus-like` is not `/menu`. */
const PAID_SECTIONS = [
  "/menu",
  "/products",
  "/sales",
  "/invoices",
  "/labor",
  "/integrations",
]

export function inPaidSection(pathname: string): boolean {
  return PAID_SECTIONS.some(
    (section) => pathname === section || pathname.startsWith(`${section}/`)
  )
}

/** The one sentence the backend answers an operations write with. */
export const NEEDS_SUBSCRIPTION = "This feature needs a subscription."

/** "9 days left", counted the way the backend counts. */
export function trialDaysLeftLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"} left`
}

/** Labels by plan first, so a lapsed status the backend has not seen before
 * still reads as the free account the user is actually on. */
export function billingStatusLabel(billing: BillingState): string {
  if (billing.status === "deleting") return "Account deletion in progress"
  if (onTrial(billing)) {
    return `Trial, ${trialDaysLeftLabel(billing.trialDaysLeft ?? 0)}`
  }
  if (onFreePlan(billing)) {
    return billing.status === "none" ? "Trial ended" : "Subscription ended"
  }
  switch (billing.status) {
    case "active":
      return "Active"
    case "past_due":
      return "Past due"
    default:
      return billing.status
  }
}
