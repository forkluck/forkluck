// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const setProductMatching = vi.hoisted(() => vi.fn())
const createBillingPortal = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  setProductMatching,
  createBillingPortal,
  deleteKitchenData: vi.fn(),
}))
vi.mock("@/components/settings/account-details-dialog", () => ({
  AccountDetailsDialog: () => null,
}))
vi.mock("@/components/settings/business-defaults-dialog", () => ({
  BusinessDefaultsDialog: () => null,
}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  deleteAnthropicKey: vi.fn(),
  saveAnthropicKey: vi.fn(),
}))
vi.mock("@/components/settings/categories-dialog", () => ({
  CategoriesDialog: () => null,
}))
vi.mock("@/components/settings/history-dialog", () => ({
  HistoryDialog: () => null,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { ProductMatchingRow } from "@/components/settings/product-matching-row"
import { SettingsScreen } from "@/components/settings/settings-screen"
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings"

beforeEach(() => {
  setProductMatching.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the product matching row", () => {
  it("sends the new value when the switch is flipped", async () => {
    render(<ProductMatchingRow initial />)

    const toggle = screen.getByRole("switch", { name: "Product matching" })
    expect(toggle.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(toggle)

    await waitFor(() => expect(setProductMatching).toHaveBeenCalledWith(false))
    expect(toggle.getAttribute("aria-checked")).toBe("false")
  })

  it("rolls the switch back when the server refuses", async () => {
    setProductMatching.mockResolvedValue({ error: "Couldn’t change it." })
    render(<ProductMatchingRow initial />)

    fireEvent.click(screen.getByRole("switch", { name: "Product matching" }))

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn’t change it."
    )
    expect(
      screen
        .getByRole("switch", { name: "Product matching" })
        .getAttribute("aria-checked")
    ).toBe("true")
  })
})

describe("the settings screen", () => {
  it("no longer carries product matching", () => {
    render(
      <SettingsScreen
        user={{ id: "1", email: "chef@example.com", name: "Chef" } as never}
        billing={{ status: "disabled" } as never}
        businessSettings={DEFAULT_BUSINESS_SETTINGS}
        byok={false}
        aiKey={{ configured: false, hint: null }}
        newsletter={{ enabled: null, available: false }}
      />
    )

    expect(screen.queryByRole("switch")).toBeNull()
    expect(document.body.textContent).not.toContain("Product matching")
    expect(document.body.textContent).not.toContain("Sales channels")
  })

  it("keeps the Claude key where the rest of the workspace settings are", () => {
    render(
      <SettingsScreen
        user={{ id: "1", email: "chef@example.com", name: "Chef" } as never}
        billing={{ status: "disabled" } as never}
        businessSettings={DEFAULT_BUSINESS_SETTINGS}
        byok={true}
        aiKey={{ configured: false, hint: null }}
        newsletter={{ enabled: null, available: false }}
      />
    )

    expect(screen.getByText("Claude")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Configure" })).toBeTruthy()
  })

  it("shows no document tools when Forkluck's own AI does the reading", () => {
    render(
      <SettingsScreen
        user={{ id: "1", email: "chef@example.com", name: "Chef" } as never}
        billing={{ status: "disabled" } as never}
        businessSettings={DEFAULT_BUSINESS_SETTINGS}
        byok={false}
        aiKey={{ configured: false, hint: null }}
        newsletter={{ enabled: null, available: false }}
      />
    )

    // The house engine needs nothing from the merchant, so the group is
    // absent rather than a row saying there is nothing to do.
    expect(screen.queryByText("Document tools")).toBeNull()
    expect(screen.queryByText("Claude")).toBeNull()
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull()
  })
})
