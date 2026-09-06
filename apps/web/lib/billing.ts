import type { SessionPayload } from "@/lib/backend/schemas"

export type BillingState = SessionPayload["billing"]

/** "disabled" is billing switched off, not a lapse. */
export function billingLocked(billing: BillingState): boolean {
  return billing.locked
}

export function onFreePlan(billing: BillingState): boolean {
  return billing.plan === "free"
}

/** The recipe-cap banner copy, or null while the cap is not reached. */
export function recipeCapNotice(billing: BillingState): string | null {
  const { maxRecipes } = billing.entitlements
  const count = billing.recipeCount
  if (maxRecipes === null || count < maxRecipes) return null
  return count > maxRecipes
    ? `You have ${count} recipes on the Free plan, which includes ${maxRecipes}. They all keep working, but new ones need an upgrade.`
    : `${maxRecipes} of ${maxRecipes} recipes used on the Free plan. Archived recipes count, and deleting one frees a slot.`
}

/** Labels by plan, so a lapsed status the backend has not seen before still
 * reads as the Free plan the user is actually on. */
export function billingStatusLabel(billing: BillingState): string {
  if (billing.status === "deleting") return "Account deletion in progress"
  if (onFreePlan(billing)) return "Free plan"
  switch (billing.status) {
    case "trialing": {
      const days = billing.trialDaysLeft ?? 0
      return `Trial — ${days} ${days === 1 ? "day" : "days"} left`
    }
    case "active":
      return "Active"
    case "past_due":
      return "Past due"
    default:
      return billing.status
  }
}
