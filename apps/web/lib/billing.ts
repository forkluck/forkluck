import type { SessionPayload } from "@/lib/backend/schemas"

export type BillingState = SessionPayload["billing"]

/** "disabled" is billing switched off, not a lapse. */
export function billingLocked(billing: BillingState): boolean {
  return billing.locked
}

export function onTrial(billing: BillingState): boolean {
  return billing.plan === "trial"
}

/** A trial or subscription that ended: every read works, every write waits
 * on a subscription. The backend refuses the writes; this only shapes copy. */
export function billingReadOnly(billing: BillingState): boolean {
  return billing.plan === "expired"
}

/** The one-line banner a read-only account sees on every screen, or null. */
export function readOnlyNotice(billing: BillingState): string | null {
  if (!billingReadOnly(billing)) return null
  return billing.status === "none"
    ? "Your trial ended. Subscribe to keep editing."
    : "Your subscription ended. Subscribe to keep editing."
}

/** "9 days left", counted the way the backend counts. */
export function trialDaysLeftLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"} left`
}

/** Labels by plan first, so a lapsed status the backend has not seen before
 * still reads as the read-only account the user is actually on. */
export function billingStatusLabel(billing: BillingState): string {
  if (billing.status === "deleting") return "Account deletion in progress"
  if (onTrial(billing)) {
    return `Trial, ${trialDaysLeftLabel(billing.trialDaysLeft ?? 0)}`
  }
  if (billingReadOnly(billing)) {
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
