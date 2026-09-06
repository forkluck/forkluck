// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const syncStripeSubscription = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const router = vi.hoisted(() => ({ replace, refresh }))

vi.mock("@/app/(auth)/subscribe/actions", () => ({
  syncStripeSubscription,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

import { ConfirmSubscription } from "@/app/(auth)/subscribe/complete/confirm-subscription"

const free = {
  status: "none",
  plan: "free",
  trialDaysLeft: null,
  locked: false,
}
const paid = {
  status: "active",
  plan: "paid",
  trialDaysLeft: null,
  locked: false,
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("subscription confirmation", () => {
  it("polls bounded provider lag until the plan turns paid", async () => {
    syncStripeSubscription
      .mockResolvedValueOnce(free)
      .mockResolvedValueOnce(free)
      .mockResolvedValueOnce(paid)
      .mockResolvedValue(paid)
    render(<ConfirmSubscription sessionId="cs_owned" />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(syncStripeSubscription).toHaveBeenCalledOnce()
    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for Stripe"
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(syncStripeSubscription).toHaveBeenCalledTimes(3)
    expect(syncStripeSubscription).toHaveBeenNthCalledWith(3, "cs_owned")
    expect(replace).toHaveBeenCalledWith("/")
    expect(refresh).toHaveBeenCalledOnce()
  })

  it("stops after eight Free snapshots and offers a retry", async () => {
    syncStripeSubscription.mockResolvedValue(free)
    render(<ConfirmSubscription sessionId="cs_slow" />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(syncStripeSubscription).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500)
    })

    expect(screen.getByRole("alert")).toHaveProperty(
      "textContent",
      "Stripe is still finalizing your subscription. Wait a moment, then retry."
    )
    expect(syncStripeSubscription).toHaveBeenCalledTimes(8)
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
})
