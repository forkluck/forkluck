// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const createBillingPortal = vi.hoisted(() => vi.fn())

// The history dialog reaches the ingredients actions for Undo; that module
// pulls the server-only backend client, which jsdom cannot load.
vi.mock("@/app/(app)/ingredients/actions", () => ({
  undoIngredientImport: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  createBillingPortal,
  deleteCategory: vi.fn(),
  deleteExpenseCategory: vi.fn(),
  deleteKitchenData: vi.fn(),
  getCurrencyConversionQuote: vi.fn(),
  inviteKitchenMember: vi.fn(),
  leaveKitchen: vi.fn(),
  listCategories: vi.fn(async () => []),
  listKitchenMembers: vi.fn(async () => ({ members: [], invites: [] })),
  listSuppliers: vi.fn(async () => []),
  loadActivity: vi.fn(async () => ({ items: [], nextBefore: null })),
  removeKitchenInvite: vi.fn(),
  removeKitchenMember: vi.fn(),
  renameCategory: vi.fn(),
  resetGuestLinks: vi.fn(),
  saveExpenseCategory: vi.fn(),
  setProductMatching: vi.fn(),
  updateAccountName: vi.fn(),
  updateBusinessSettings: vi.fn(),
  updateKitchenMember: vi.fn(),
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  listExpenseCategories: vi.fn(async () => []),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { SettingsScreen } from "@/components/settings/settings-screen"
import type { BillingState } from "@/lib/billing"
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings"

const PAID_ENTITLEMENTS = {
  primo: true,
  posSync: true,
  connectors: true,
  usdaSearch: true,
  catalogSearch: true,
  invoiceAi: true,
}

function billingState(status: string, plan: string): BillingState {
  return {
    status,
    trialDaysLeft: plan === "trial" ? 9 : null,
    locked: false,
    plan,
    entitlements:
      plan === "expired"
        ? {
            primo: false,
            posSync: false,
            connectors: false,
            usdaSearch: false,
            catalogSearch: false,
            invoiceAi: false,
          }
        : PAID_ENTITLEMENTS,
    recipeCount: 0,
  }
}

function renderSettings(billing: BillingState) {
  render(
    <SettingsScreen
      user={{
        id: "usr-1",
        name: "Ana Reyes",
        email: "ana@example.com",
        hasPassword: true,
      }}
      billing={billing}
      businessSettings={DEFAULT_BUSINESS_SETTINGS}
      byok={false}
      aiKey={{ configured: false, hint: null }}
      newsletter={{ enabled: null, available: false }}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("billing settings", () => {
  it("asks which owned customer to manage when an account has more than one", async () => {
    createBillingPortal
      .mockResolvedValueOnce({
        customers: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            label: "Subscription 1",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            label: "Subscription 2",
          },
        ],
      })
      .mockResolvedValueOnce({ error: "Couldn’t open that billing account." })
    renderSettings(billingState("active", "paid"))

    fireEvent.click(screen.getByRole("button", { name: /Manage billing/ }))
    expect(await screen.findByText("Choose a billing account")).toBeTruthy()
    const second = screen.getByRole("button", { name: "Subscription 2" })
    await waitFor(() => expect(second).toHaveProperty("disabled", false))
    fireEvent.click(second)

    await waitFor(() =>
      expect(createBillingPortal).toHaveBeenLastCalledWith(
        "22222222-2222-4222-8222-222222222222"
      )
    )
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn’t open that billing account."
    )
  })

  it("offers only the subscription before a customer exists", () => {
    renderSettings(billingState("none", "trial"))

    const subscribe = screen.getByRole("link", { name: /Subscribe/ })
    expect(subscribe).toHaveProperty("href", "http://localhost:3000/subscribe")
    expect(subscribe.textContent).toContain(
      "Trial, 9 days left. $7 a month. Cancel any time."
    )
    expect(screen.queryByRole("button", { name: /Manage billing/ })).toBeNull()
  })

  it("names the trial that ended on the subscription row", () => {
    renderSettings(billingState("none", "expired"))

    expect(
      screen.getByRole("link", { name: /Subscribe/ }).textContent
    ).toContain("Trial ended. $7 a month. Cancel any time.")
  })

  it("keeps the portal beside the subscription row after a lapse", () => {
    renderSettings(billingState("canceled", "expired"))

    expect(screen.getByRole("button", { name: /Manage billing/ })).toBeTruthy()
    expect(
      screen.getByRole("link", { name: /Subscribe/ }).textContent
    ).toContain("Subscription ended. $7 a month. Cancel any time.")
  })

  it("shows no subscription row on the paid plan", () => {
    renderSettings(billingState("active", "paid"))

    expect(screen.getByRole("button", { name: /Manage billing/ })).toBeTruthy()
    expect(screen.queryByRole("link", { name: /Subscribe/ })).toBeNull()
  })

  // Members are unlimited on every plan, so the Kitchen group stands above
  // billing whatever billing says.
  it("keeps the Members row above the billing group", () => {
    renderSettings(billingState("none", "trial"))

    expect(screen.getByRole("button", { name: /Members/ })).toBeTruthy()
  })
})
