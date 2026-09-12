import { afterEach, describe, expect, it, vi } from "vitest"

import type { BillingState } from "@/lib/billing"

const mocks = vi.hoisted(() => ({ configured: vi.fn(() => true) }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/primo/model", () => ({
  primoConfigured: () => mocks.configured(),
}))

import { primoAvailable } from "@/lib/primo/access"

function billing(primo: boolean): BillingState {
  return {
    status: primo ? "active" : "none",
    trialDaysLeft: null,
    locked: false,
    plan: primo ? "paid" : "expired",
    entitlements: {
      primo,
      posSync: true,
      connectors: true,
      usdaSearch: true,
      catalogSearch: true,
      invoiceAi: true,
    },
    recipeCount: 0,
  }
}

describe("primoAvailable", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is off for everyone when Primo is not configured", () => {
    mocks.configured.mockReturnValueOnce(false)
    expect(primoAvailable(billing(true))).toBe(false)
  })

  it("is on for every plan outside production", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(primoAvailable(billing(false))).toBe(true)
  })

  it("needs the paid entitlement in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(primoAvailable(billing(true))).toBe(true)
    expect(primoAvailable(billing(false))).toBe(false)
  })
})
