// @vitest-environment jsdom

import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  LineCostFields,
  type LineCostValue,
} from "@/components/invoices/line-cost-fields"

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))

afterEach(cleanup)

const INGREDIENTS = [{ id: "ing-butter", name: "Butter", nonEdible: false }]

const COUNT_NOTE =
  "Recipes measured by weight will need the weight of one; set it on the ingredient’s Conversions."

function renderFields(value: Partial<LineCostValue> = {}) {
  render(
    <LineCostFields
      idPrefix="line-1"
      value={{
        ingredientId: "",
        name: "Club soda",
        amount: "24",
        unit: "lb",
        price: "21.59",
        ...value,
      }}
      onChange={() => {}}
      ingredients={INGREDIENTS}
      currencyCode="USD"
      fallbackName="Club soda"
    />
  )
}

describe("LineCostFields", () => {
  it("asks for the pack in any purchasing unit, grouped by family", () => {
    renderFields()
    expect(screen.getByLabelText("Pack size")).toBeTruthy()
    fireEvent.click(screen.getByRole("combobox", { name: "Pack size unit" }))
    expect(screen.getByRole("group", { name: "Weight" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Volume" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Package" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "gal" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "each" })).toBeTruthy()
  })

  it("says a count pack still needs the weight of one", () => {
    renderFields({ unit: "each" })
    expect(screen.getByText(COUNT_NOTE)).toBeTruthy()
  })

  it("says nothing of the kind for a weight or a volume pack", () => {
    renderFields({ unit: "ml" })
    expect(screen.queryByText(COUNT_NOTE)).toBeNull()
  })
})
