// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const saveIngredient = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  clearIngredientNutrition: vi.fn(),
  saveIngredient: (input: unknown) => saveIngredient(input),
  searchNutritionFoods: vi.fn(),
  setIngredientNutrition: vi.fn(),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import { IngredientForm } from "@/components/ingredients/ingredient-form"

afterEach(() => {
  cleanup()
  saveIngredient.mockReset()
})

const caseBought = {
  id: "ing-1",
  name: "Eggs",
  editVersion: 3,
  purchaseCostCents: 5000,
  purchaseSize: 1,
  purchaseUnit: "case",
  priceSource: "user" as const,
  category: null,
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
}

describe("renaming an ingredient bought in a non-weight unit", () => {
  it("leaves the pack out of the payload", async () => {
    // The pack belongs to `ingredient:<id>:purchase-unit`; a rename that
    // restated it would put a stale price back.
    saveIngredient.mockResolvedValue({
      id: "ing-1",
      publicId: "ing_1",
      editVersion: 4,
    })
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={caseBought}
        section="ingredient"
        actions
        onDone={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Eggs, large" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))

    await waitFor(() => expect(saveIngredient).toHaveBeenCalled())
    expect(saveIngredient).toHaveBeenCalledWith({
      id: "ing-1",
      name: "Eggs, large",
      category: null,
      tags: [],
      expectedEditVersion: 3,
    })
  })

  it("allows a new ingredient without a purchase draft", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-2",
      publicId: "ing_2",
      editVersion: 0,
    })
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={null}
        initialName="New ingredient"
        actions
        onDone={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))

    await waitFor(() => expect(saveIngredient).toHaveBeenCalled())
    expect(saveIngredient).toHaveBeenCalledWith({
      id: null,
      name: "New ingredient",
      category: null,
      tags: [],
      purchaseCostCents: 0,
      purchaseSize: null,
      purchaseUnit: null,
    })
  })

  it("does not render duplicate purchase fields", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-1",
      publicId: "ing_1",
      editVersion: 4,
    })
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={caseBought}
        section="all"
        actions
        onDone={vi.fn()}
      />
    )

    // None of the Price form's fields: the Cost section is the only place
    // that asks for them.
    for (const label of [
      "Cost (USD)",
      "Size",
      "Invoice item",
      "Vendor",
      "Item name",
      "ID",
      "Date added",
    ])
      expect(screen.queryByLabelText(label)).toBeNull()
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Eggs, large" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))

    await waitFor(() => expect(saveIngredient).toHaveBeenCalled())
    expect(saveIngredient.mock.calls[0][0]).not.toHaveProperty(
      "purchaseCostCents"
    )
  })

  it("saves tags selected from the profile sidebar", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-2",
      publicId: "ing_2",
      editVersion: 0,
    })
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={null}
        initialName="Carrots"
        profileLayout
        availableTags={[{ id: "tag-1", name: "Produce", count: 1 }]}
        actions
        onDone={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Add tags" }))
    fireEvent.click(screen.getByRole("button", { name: "Produce" }))
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))

    await waitFor(() =>
      expect(saveIngredient).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Carrots", tags: ["Produce"] })
      )
    )
  })
})
