// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
// The Track dialog's member picker reaches components-dialog's menu action.
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))
vi.mock("@/app/(app)/products/actions", () => ({
  unignoreSalesModifiers: vi.fn(),
  unignoreSalesSkus: vi.fn(),
  saveSalesProduct: vi.fn(),
  deleteSalesProduct: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/integrations/sales/mapping/ignored",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD" }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

import { IgnoredTable } from "@/components/menu/ignored-table"
import type { SalesIgnoredItem } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

function ignoredItem(
  channel: "square" | "shopify",
  externalName: string,
  source: "manual" | "rule" = "manual"
): SalesIgnoredItem {
  return {
    id: `${channel}-${externalName}`,
    identityKind: "item",
    channel,
    providerAccountId: channel === "square" ? "M1" : "shop-1",
    matchKey: `${channel}:item:${externalName}`,
    sku: `SKU-${externalName}`,
    externalName,
    externalVariantTitle: "",
    lineCount: 1,
    quantity: 2,
    netSalesCents: 1000,
    currencyCode: "USD",
    lastSoldAt: null,
    source,
    ruleId: source === "rule" ? "rule-1" : null,
  }
}

const items = [
  ignoredItem("shopify", "Earl Grey"),
  ignoredItem("square", "Chai"),
]

function renderTable() {
  return render(
    <IgnoredTable
      items={items}
      modifiers={[]}
      itemCount={items.length}
      modifierCount={0}
    />
  )
}

describe("IgnoredTable", () => {
  it("groups rows under a header per channel, open by default", () => {
    renderTable()
    expect(screen.getByText("Shopify · 1 row")).toBeTruthy()
    expect(screen.getByText("Square · 1 row")).toBeTruthy()
    expect(screen.getByText("Earl Grey")).toBeTruthy()
    expect(screen.getByText("Chai")).toBeTruthy()
  })

  it("collapses a group and keeps the choice in sessionStorage", () => {
    renderTable()
    fireEvent.click(screen.getAllByLabelText("Collapse group")[0])
    expect(screen.queryByText("Earl Grey")).toBeNull()
    expect(screen.getByText("Chai")).toBeTruthy()
    expect(
      JSON.parse(sessionStorage.getItem("fl.ignored.groups") ?? "{}")
    ).toEqual({ shopify: false })
  })

  it("filters to one channel from the Channel pill", () => {
    renderTable()
    fireEvent.click(screen.getByLabelText("Channel: All"))
    fireEvent.click(screen.getByText("Square"))
    expect(screen.queryByText("Shopify · 1 row")).toBeNull()
    expect(screen.getByText("Square · 1 row")).toBeTruthy()
    expect(screen.queryByText("Earl Grey")).toBeNull()
  })

  it("sends a rule-owned row to its rule instead of offering Restore", () => {
    // Restoring it would only invite the next sweep to write it straight back.
    const ruleOwned = [ignoredItem("square", "Gift card", "rule")]
    render(
      <IgnoredTable
        items={ruleOwned}
        modifiers={[]}
        itemCount={1}
        modifierCount={0}
      />
    )
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(
      screen.getByRole("link", { name: "Rule" }).getAttribute("href")
    ).toBe("/integrations/sales/mapping/rules")
  })

  it("sends Add product to the create page", () => {
    renderTable()
    expect(
      screen.getByRole("link", { name: "Add product" }).getAttribute("href")
    ).toBe("/products/new")
  })

  it("still offers Restore for a row ignored by hand", () => {
    renderTable()
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2)
  })
})
