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

it("tells a free account what stays free and what the subscription adds", () => {
  const { rerender } = render(
    <SubscribeCard email="cook@example.test" state="trialEnded" canReturn />
  )
  expect(
    screen.getByText(
      "Your trial has ended. Recipes, ingredients, costing and nutrition stay free. Menus, sales, invoices, labor and Primo need a subscription: $7 a month. Cancel anytime."
    )
  ).toBeTruthy()
  rerender(<SubscribeCard email="cook@example.test" state="lapsed" canReturn />)
  expect(
    screen.getByText(
      "Your subscription has ended. Recipes, ingredients, costing and nutrition stay free. Menus, sales, invoices, labor and Primo need a subscription: $7 a month. Cancel anytime."
    )
  ).toBeTruthy()
})
