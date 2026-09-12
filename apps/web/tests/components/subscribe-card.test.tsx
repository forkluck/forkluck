// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/app/(auth)/subscribe/actions", () => ({
  createStripeCheckout: vi.fn(),
  syncStripeSubscription: vi.fn(async () => ({ ok: true })),
}))

import { SubscribeCard } from "@/app/(auth)/subscribe/subscribe-card"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it("releases subscription status refresh after the action and route settle", async () => {
  render(<SubscribeCard email="cook@example.test" state="trial" canReturn />)
  const button = screen.getByRole("button", {
    name: "Already subscribed? Refresh status",
  })
  fireEvent.click(button)
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  await waitFor(() => expect(button).toHaveProperty("disabled", false))
})
