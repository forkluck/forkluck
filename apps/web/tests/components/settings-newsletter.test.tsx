// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const setNewsletter = vi.hoisted(() => vi.fn())

vi.mock("@/app/(app)/invoices/actions", () => ({
  listExpenseCategories: vi.fn(async () => []),
}))
// The history dialog reaches the ingredients actions for Undo; that module
// pulls the server-only backend client, which jsdom cannot load.
vi.mock("@/app/(app)/ingredients/actions", () => ({
  undoIngredientImport: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  createBillingPortal: vi.fn(),
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
  setNewsletter,
  setProductMatching: vi.fn(),
  updateAccountName: vi.fn(),
  updateBusinessSettings: vi.fn(),
  updateKitchenMember: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { SettingsScreen } from "@/components/settings/settings-screen"
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings"
import type { NewsletterStatus } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function settings(newsletter: NewsletterStatus) {
  render(
    <SettingsScreen
      user={{ id: "usr-1", name: "Ana Reyes", email: "ana@example.com" }}
      billing={{
        status: "disabled",
        trialDaysLeft: null,
        locked: false,
        plan: "paid",
        entitlements: {
          maxRecipes: null,
          primo: true,
          posSync: true,
          connectors: true,
          usdaSearch: true,
          catalogSearch: true,
          invoiceAi: true,
        },
        recipeCount: 0,
      }}
      businessSettings={DEFAULT_BUSINESS_SETTINGS}
      byok={false}
      aiKey={{ configured: false, hint: null }}
      newsletter={newsletter}
    />
  )
}

function toggle() {
  return screen.getByRole("switch", { name: "Product updates" })
}

describe("the product-updates row", () => {
  it("is absent when the newsletter is not configured", () => {
    settings({ enabled: null, available: false })

    expect(screen.queryByText("Product updates")).toBeNull()
  })

  it("shows the subscription Ghost holds and writes a change through", async () => {
    setNewsletter.mockResolvedValue({ ok: true })
    settings({ enabled: false, available: true })

    expect(toggle().getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle())

    // Optimistic: the switch moves before the action answers.
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    await waitFor(() => expect(setNewsletter).toHaveBeenCalledWith(true))
  })

  it("puts the switch back and says so when the write fails", async () => {
    setNewsletter.mockResolvedValue({ error: "Ghost is unreachable." })
    settings({ enabled: true, available: true })

    fireEvent.click(toggle())

    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("true")
    )
    expect(screen.getByRole("alert").textContent).toBe("Ghost is unreachable.")
  })
})
