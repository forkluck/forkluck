// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const setPreferredSupplierItem = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/ingredients/actions", () => ({
  setPreferredSupplierItem,
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import { SupplierProductsDialog } from "@/components/ingredients/supplier-products-dialog"
import type { IngredientRow } from "@/lib/backend/types"

const now = new Date("2026-08-07T12:00:00Z")

function pack(id: string, isPreferred: boolean) {
  return {
    id,
    supplier: "acme",
    externalId: id,
    title: `Pack ${id}`,
    rawSize: "1 KG",
    packPriceCents: 1200,
    packGrams: 1000,
    packAmount: 1,
    packUnit: "kg",
    purchasedQuantity: 1,
    periodStart: null,
    periodEnd: null,
    isPreferred,
    updatedAt: now,
  }
}

const INGREDIENT = {
  id: "ing-1",
  publicId: "ing_000000000001",
  userId: "u",
  editVersion: 0,
  name: "Baby Arugula",
  normalizedName: "baby arugula",
  measureName: "Baby Arugula",
  purchaseCostCents: 1200,
  purchaseSize: 1,
  purchaseUnit: "kg",
  yieldPercent: 100,
  priceSource: "user",
  categoryId: null,
  category: null,
  status: "active",
  usedInRecipes: [],
  usedInProducts: [],
  tags: [],
  effectiveAllergenKeys: [],
  previousPrice: null,
  preferredSupplier: null,
  needsAttention: [],
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
  createdAt: now,
  updatedAt: now,
  priceHistory: [],
  supplierItems: [pack("s1", true), pack("s2", false)],
  invoicePrices: [],
  preparations: [],
  conversion: null,
  effectiveAllergens: [],
} satisfies IngredientRow

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function choose() {
  render(
    <SupplierProductsDialog
      ingredient={INGREDIENT}
      open
      onOpenChange={vi.fn()}
    />
  )
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use this pack" }))
  })
}

describe("the supplier packs dialog", () => {
  it("moves the preferred pack once the write landed", async () => {
    setPreferredSupplierItem.mockResolvedValue(undefined)

    await choose()

    expect(setPreferredSupplierItem).toHaveBeenCalledWith("s2")
    // The chosen pack now carries the badge, and the old one offers the button.
    expect(screen.getAllByText("Preferred")).toHaveLength(1)
    expect(
      screen.getAllByRole("button", { name: "Use this pack" })
    ).toHaveLength(1)
  })

  it("puts the pack back and says why when the write did not land", async () => {
    setPreferredSupplierItem.mockRejectedValue(new Error("Backend is down"))

    await choose()

    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
    expect(screen.getAllByText("Preferred")).toHaveLength(1)
  })
})
