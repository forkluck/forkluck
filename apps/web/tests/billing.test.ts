import { describe, expect, it } from "vitest"

import {
  billingLocked,
  billingReadOnly,
  billingStatusLabel,
  onTrial,
  readOnlyNotice,
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
const EXPIRED_ENTITLEMENTS = {
  primo: false,
  posSync: false,
  connectors: false,
  usdaSearch: false,
  catalogSearch: false,
  invoiceAi: false,
}

const PAID_STATUSES = ["disabled", "trialing", "active", "past_due"]

/** A session the backend would ship: paid statuses are paid, everything
 * else is the calendar trial or the read-only account after it. */
function state(
  status: string,
  trialDaysLeft: number | null = null,
  locked = status === "deleting",
  plan = PAID_STATUSES.includes(status)
    ? "paid"
    : trialDaysLeft === null
      ? "expired"
      : "trial"
): BillingState {
  return {
    status,
    trialDaysLeft,
    locked,
    plan,
    entitlements: plan === "expired" ? EXPIRED_ENTITLEMENTS : PAID_ENTITLEMENTS,
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

  it("leaves every lapsed status unlocked: read-only is not a lock", () => {
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
  it("reads the trial and the read-only state the backend derived", () => {
    expect(onTrial(state("none", 9))).toBe(true)
    expect(onTrial(state("canceled", 2))).toBe(true)
    expect(onTrial(state("active"))).toBe(false)
    expect(billingReadOnly(state("none"))).toBe(true)
    expect(billingReadOnly(state("canceled"))).toBe(true)
    expect(billingReadOnly(state("none", 9))).toBe(false)
    expect(billingReadOnly(state("disabled"))).toBe(false)
  })
})

describe("read-only notice", () => {
  it("tells a trial that ran out apart from a subscription that ended", () => {
    expect(readOnlyNotice(state("none"))).toBe(
      "Your trial ended. Subscribe to keep editing."
    )
    expect(readOnlyNotice(state("canceled"))).toBe(
      "Your subscription ended. Subscribe to keep editing."
    )
    expect(readOnlyNotice(state("unpaid"))).toBe(
      "Your subscription ended. Subscribe to keep editing."
    )
  })

  it("is silent while writes are allowed", () => {
    expect(readOnlyNotice(state("none", 14))).toBeNull()
    expect(readOnlyNotice(state("active"))).toBeNull()
    expect(readOnlyNotice(state("disabled"))).toBeNull()
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

  it("labels a read-only account by what ended", () => {
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
