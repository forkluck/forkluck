// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const relinkSupplierItem = vi.hoisted(() => vi.fn())
const ignoreSupplierItem = vi.hoisted(() => vi.fn())
const unignoreSupplierItem = vi.hoisted(() => vi.fn())
const deleteSupplierItem = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("@/app/(app)/settings/actions", () => ({
  relinkSupplierItem,
  ignoreSupplierItem,
  unignoreSupplierItem,
  deleteSupplierItem,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/integrations/suppliers/mapping",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD" }),
}))

import { SupplierItemsTable } from "@/components/integrations/supplier-items-table"
import type {
  SupplierItemIgnoreRow,
  SupplierItemMappingRow,
} from "@/lib/backend/types"

const butter: SupplierItemMappingRow = {
  id: "item-1",
  supplier: "baldor",
  supplierName: "Baldor",
  externalId: "DABUT11",
  hasCode: true,
  title: "Butter, unsalted 36X1 LB",
  rawSize: "36X1 LB",
  packPriceCents: 12450,
  packAmount: 16.33,
  packUnit: "kg",
  ingredientId: "ing-1",
  ingredientName: "Butter",
  isPreferred: true,
  timesSeen: 7,
  lastInvoiceDate: "2026-08-09",
}

const cream: SupplierItemMappingRow = {
  ...butter,
  id: "item-2",
  packPriceCents: 899,
  supplier: "wegmans",
  supplierName: "Wegmans",
  externalId: "desc:og hvy whp crm uht",
  hasCode: false,
  title: "OG HVY WHP CRM UHT",
  rawSize: "",
  ingredientId: "ing-2",
  ingredientName: "Heavy cream",
  timesSeen: 2,
  lastInvoiceDate: null,
}

const ignoredRow: SupplierItemIgnoreRow = {
  id: "ignore-1",
  supplier: "arrow-linen",
  supplierName: "Arrow Linen",
  externalId: "LINEN-SVC",
  hasCode: true,
  title: "Linen service",
  rawSize: "",
}

const suppliers = [
  {
    id: "sup-1",
    key: "baldor",
    name: "Baldor",
    email: "",
    phone: "",
    accountNumber: "",
    notes: "",
    defaultCategoryId: null,
    invoiceCount: 3,
    itemCount: 2,
    ignoreCount: 0,
  },
]

const ingredients = [
  { id: "ing-1", name: "Butter", nonEdible: false },
  { id: "ing-2", name: "Heavy cream", nonEdible: false },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function table(
  props: Partial<React.ComponentProps<typeof SupplierItemsTable>> = {}
) {
  render(
    <SupplierItemsTable
      rows={[butter, cream]}
      total={2}
      offset={0}
      limit={50}
      view="all"
      supplier=""
      query=""
      suppliers={suppliers}
      ingredients={ingredients}
      {...props}
    />
  )
}

describe("the supplier items table", () => {
  it("lists each remembered pack with what it buys", () => {
    table()

    expect(screen.getByText("DABUT11")).toBeTruthy()
    expect(screen.getByText("Butter")).toBeTruthy()
    expect(screen.getByText("$124.50")).toBeTruthy()
    expect(screen.getByText("7")).toBeTruthy()
    expect(screen.getByText("Aug 9")).toBeTruthy()
  })

  it("shows the description where a pack has no printed code", () => {
    table()

    expect(screen.getByText("OG HVY WHP CRM UHT")).toBeTruthy()
    expect(screen.getByText("No code · Wegmans")).toBeTruthy()
    // Nothing has been billed under it yet.
    expect(screen.getByText("—")).toBeTruthy()
  })

  it("re-points a pack at another ingredient", async () => {
    relinkSupplierItem.mockResolvedValue({ ok: true })
    table()

    fireEvent.click(screen.getByRole("button", { name: "Actions for DABUT11" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Relink" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Match ingredient" })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Heavy cream" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(relinkSupplierItem).toHaveBeenCalledWith("item-1", "ing-2")
  })

  it("asks before it forgets a pack", async () => {
    ignoreSupplierItem.mockResolvedValue({ ok: true })
    table()

    fireEvent.click(screen.getByRole("button", { name: "Actions for DABUT11" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ignore" }))
    expect(ignoreSupplierItem).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Ignore", hidden: true })
      )
    })

    expect(ignoreSupplierItem).toHaveBeenCalledWith("item-1")
  })

  it("says why an edit did not land", async () => {
    ignoreSupplierItem.mockResolvedValue({ error: "Backend is down" })
    table()

    fireEvent.click(screen.getByRole("button", { name: "Actions for DABUT11" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ignore" }))
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Ignore", hidden: true })
      )
    })

    // The confirm stays open over an error, so the row behind it is hidden.
    expect(screen.getByRole("alert", { hidden: true }).textContent).toBe(
      "Backend is down"
    )
  })

  it("takes a skipped key off the list, keyed on its supplier", async () => {
    unignoreSupplierItem.mockResolvedValue({ ok: true })
    table({ rows: [ignoredRow], total: 1, view: "ignored" })

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for LINEN-SVC" })
    )
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Unignore" }))
    })

    expect(unignoreSupplierItem).toHaveBeenCalledWith(
      "arrow-linen",
      "LINEN-SVC"
    )
  })
})
