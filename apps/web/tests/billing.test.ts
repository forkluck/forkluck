import { describe, expect, it } from "vitest"

import { billingLocked, billingStatusLabel, onFreePlan } from "../lib/billing"
import type { BillingState } from "../lib/billing"

const PAID_ENTITLEMENTS = {
  maxRecipes: null,
  primo: true,
  posSync: true,
  connectors: true,
  usdaSearch: true,
  catalogSearch: true,
  invoiceAi: true,
}
const FREE_ENTITLEMENTS = { ...PAID_ENTITLEMENTS, maxRecipes: 10, primo: false }

function state(
  status: string,
  trialDaysLeft: number | null = null,
  locked = status === "deleting",
  plan = ["disabled", "trialing", "active", "past_due"].includes(status)
    ? "paid"
    : "free"
): BillingState {
  return {
    status,
    trialDaysLeft,
    locked,
    plan,
    entitlements: plan === "paid" ? PAID_ENTITLEMENTS : FREE_ENTITLEMENTS,
    recipeCount: 0,
  }
}

describe("billing lock", () => {
  it("lets billing-off and live subscriptions through", () => {
    expect(billingLocked(state("disabled"))).toBe(false)
    expect(billingLocked(state("trialing", 14))).toBe(false)
    expect(billingLocked(state("active"))).toBe(false)
    expect(billingLocked(state("past_due"))).toBe(false)
  })

  it("leaves every lapsed status unlocked on the Free plan", () => {
    for (const status of [
      "none",
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ]) {
      expect(billingLocked(state(status))).toBe(false)
    }
    expect(billingLocked(state("deleting"))).toBe(true)
  })

  it("uses the backend's centralized precedence result", () => {
    expect(billingLocked(state("unknown_provider_status", null, false))).toBe(
      false
    )
    expect(billingLocked(state("active", null, true))).toBe(true)
  })
})

describe("free plan", () => {
  it("reads the plan the backend derived", () => {
    expect(onFreePlan(state("none"))).toBe(true)
    expect(onFreePlan(state("canceled"))).toBe(true)
    expect(onFreePlan(state("active"))).toBe(false)
    expect(onFreePlan(state("disabled"))).toBe(false)
  })
})

describe("billing status label", () => {
  it("counts down the trial", () => {
    expect(billingStatusLabel(state("trialing", 1))).toBe("Trial — 1 day left")
    expect(billingStatusLabel(state("trialing", 9))).toBe("Trial — 9 days left")
  })

  it("names the paid statuses", () => {
    expect(billingStatusLabel(state("active"))).toBe("Active")
    expect(billingStatusLabel(state("past_due"))).toBe("Past due")
  })

  it("labels every free-plan account as the free plan", () => {
    expect(billingStatusLabel(state("none"))).toBe("Free plan")
    expect(billingStatusLabel(state("canceled"))).toBe("Free plan")
    expect(billingStatusLabel(state("unpaid"))).toBe("Free plan")
    expect(billingStatusLabel(state("incomplete_expired"))).toBe("Free plan")
  })

  it("keeps the deletion label", () => {
    expect(billingStatusLabel(state("deleting"))).toBe(
      "Account deletion in progress"
    )
  })

  it("falls back to a paid status Stripe added later", () => {
    expect(billingStatusLabel(state("renewing", null, false, "paid"))).toBe(
      "renewing"
    )
  })
})
