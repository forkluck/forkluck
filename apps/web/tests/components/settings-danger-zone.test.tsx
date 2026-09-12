// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const deleteKitchenData = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const toastAdd = vi.hoisted(() => vi.fn())

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
  deleteKitchenData,
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
  resetGuestLinks: vi.fn(async () => ({ ok: true, revoked: 0 })),
  saveExpenseCategory: vi.fn(),
  setProductMatching: vi.fn(),
  updateAccountName: vi.fn(),
  updateBusinessSettings: vi.fn(),
  updateKitchenMember: vi.fn(),
}))
vi.mock("next/navigation", () => {
  const router = { push, refresh: vi.fn() }
  return { useRouter: () => router }
})
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { SettingsScreen } from "@/components/settings/settings-screen"
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings"

beforeEach(() => {
  deleteKitchenData.mockResolvedValue({ ok: true, deleted: { recipes: 4 } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function settings() {
  render(
    <SettingsScreen
      user={{
        id: "usr-1",
        name: "Ana Reyes",
        email: "ana@example.com",
        hasPassword: true,
      }}
      billing={{
        status: "disabled",
        trialDaysLeft: null,
        locked: false,
        plan: "paid",
        entitlements: {
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
      newsletter={{ enabled: null, available: false }}
    />
  )
}

/** The row's Delete opens the confirm; the confirm's own Delete is the last
 *  one on screen once it is open. */
function confirmButton() {
  const buttons = screen.getAllByRole("button", { name: "Delete" })
  return buttons[buttons.length - 1] as HTMLButtonElement
}

describe("the danger zone", () => {
  it("waits for the typed word before it deletes anything", async () => {
    settings()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(await screen.findByText("Delete all kitchen data?")).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    })
    expect(confirmButton().disabled).toBe(false)
    fireEvent.click(confirmButton())

    await waitFor(() => expect(deleteKitchenData).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({ title: "Kitchen data deleted." })
    )
    expect(push).toHaveBeenCalledWith("/recipes")
  })

  it("keeps the user on the page when the delete fails", async () => {
    deleteKitchenData.mockResolvedValue({ error: "Couldn’t delete." })
    settings()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    fireEvent.change(await screen.findByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    })
    fireEvent.click(confirmButton())

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t delete."
    )
    expect(push).not.toHaveBeenCalled()
  })
})

describe("account security", () => {
  it("opens the password form from the Account group", async () => {
    settings()

    fireEvent.click(screen.getByRole("button", { name: /^Password/ }))

    expect(
      await screen.findByRole("heading", { name: "Change password" })
    ).toBeTruthy()
    expect(screen.getByLabelText("Current password")).toBeTruthy()
  })
})
