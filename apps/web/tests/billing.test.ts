import { describe, expect, it } from "vitest"

import {
  billingLocked,
  billingStatusLabel,
  inPaidSection,
  onFreePlan,
  onTrial,
  trialDaysLeftLabel,
} from "../lib/billing"
import type { BillingState } from "../lib/billing"

const PAID_ENTITLEMENTS = {
  primo: true,
  posSync: true,
  connectors: true,
  usdaSearch: true,
  catalogSearch: true,
  invoiceAi: true,
}
const FREE_ENTITLEMENTS = {
  primo: false,
  posSync: false,
  connectors: false,
  usdaSearch: true,
  catalogSearch: true,
  invoiceAi: false,
}

const PAID_STATUSES = ["disabled", "trialing", "active", "past_due"]

/** A session the backend would ship: paid statuses are paid, everything
 * else is the calendar trial or the free account after it. */
function state(
  status: string,
  trialDaysLeft: number | null = null,
  locked = status === "deleting",
  plan = PAID_STATUSES.includes(status)
    ? "paid"
    : trialDaysLeft === null
      ? "free"
      : "trial"
): BillingState {
  return {
    status,
    trialDaysLeft,
    locked,
    plan,
    entitlements: plan === "free" ? FREE_ENTITLEMENTS : PAID_ENTITLEMENTS,
    recipeCount: 0,
  }
}

describe("billing lock", () => {
  it("lets billing-off, trials and live subscriptions through", () => {
    expect(billingLocked(state("disabled"))).toBe(false)
    expect(billingLocked(state("none", 14))).toBe(false)
    expect(billingLocked(state("active"))).toBe(false)
    expect(billingLocked(state("past_due"))).toBe(false)
  })

  it("leaves every lapsed status unlocked: free is not a lock", () => {
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

describe("plan", () => {
  it("reads the trial and the free plan the backend derived", () => {
    expect(onTrial(state("none", 9))).toBe(true)
    expect(onTrial(state("canceled", 2))).toBe(true)
    expect(onTrial(state("active"))).toBe(false)
    expect(onFreePlan(state("none"))).toBe(true)
    expect(onFreePlan(state("canceled"))).toBe(true)
    expect(onFreePlan(state("none", 9))).toBe(false)
    expect(onFreePlan(state("disabled"))).toBe(false)
  })
})

describe("paid sections", () => {
  it("names the operations sections by their first path segment", () => {
    for (const path of [
      "/menu",
      "/menu/mnu_1",
      "/products",
      "/sales/imports",
      "/invoices",
      "/labor",
      "/integrations/sales/connections",
    ]) {
      expect(inPaidSection(path), path).toBe(true)
    }
  })

  it("leaves recipe development and everything else alone", () => {
    for (const path of [
      "/",
      "/recipes",
      "/recipes/rcp_1/cost",
      "/ingredients/ing_1",
      "/costs",
      "/settings",
      "/menus-like",
      "/invoicesx",
    ]) {
      expect(inPaidSection(path), path).toBe(false)
    }
  })
})

describe("billing status label", () => {
  it("counts down the trial", () => {
    expect(trialDaysLeftLabel(1)).toBe("1 day left")
    expect(billingStatusLabel(state("none", 1))).toBe("Trial, 1 day left")
    expect(billingStatusLabel(state("none", 9))).toBe("Trial, 9 days left")
    expect(billingStatusLabel(state("none", 0))).toBe("Trial, 0 days left")
  })

  it("names the paid statuses", () => {
    expect(billingStatusLabel(state("active"))).toBe("Active")
    expect(billingStatusLabel(state("past_due"))).toBe("Past due")
  })

  it("labels a free account by what ended", () => {
    expect(billingStatusLabel(state("none"))).toBe("Trial ended")
    expect(billingStatusLabel(state("canceled"))).toBe("Subscription ended")
    expect(billingStatusLabel(state("unpaid"))).toBe("Subscription ended")
    expect(billingStatusLabel(state("incomplete_expired"))).toBe(
      "Subscription ended"
    )
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
