// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { saveIngredient } = vi.hoisted(() => ({
  saveIngredient: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  clearIngredientNutrition: vi.fn(),
  saveIngredient,
  searchNutritionFoods: vi.fn(),
  setIngredientNutrition: vi.fn(),
}))

import { IngredientForm } from "@/components/ingredients/ingredient-form"

const butter = {
  id: "ing-1",
  name: "Butter",
  editVersion: 2,
  category: null,
  purchaseCostCents: 500,
  purchaseSize: 1,
  purchaseUnit: "lb",
  priceSource: "user" as const,
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
  tags: [],
}

afterEach(cleanup)

describe("the ingredient category field", () => {
  it("sends the picked category with the save", async () => {
    saveIngredient.mockResolvedValue({
      id: "ing-1",
      publicId: "ing_1",
      editVersion: 3,
    })
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={butter}
        section="ingredient"
        profileLayout
        categoryOptions={["Dairy", "Produce"]}
        actions
        onDone={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Category" }))
    fireEvent.click(await screen.findByRole("button", { name: "Dairy" }))
    fireEvent.click(screen.getByRole("button", { name: "Save ingredient" }))

    await waitFor(() => expect(saveIngredient).toHaveBeenCalled())
    expect(saveIngredient).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ing-1", category: "Dairy" })
    )
  })

  it("keeps a saved category the option list does not carry", () => {
    render(
      <IngredientForm
        saveRef={{ current: null }}
        initial={{ ...butter, category: "Fats" }}
        section="ingredient"
        profileLayout
        categoryOptions={["Dairy"]}
        actions
        onDone={vi.fn()}
      />
    )

    const trigger = screen.getByRole("button", { name: "Category" })
    expect(trigger.textContent).toContain("Fats")
    fireEvent.click(trigger)
    expect(screen.getByRole("button", { name: "Fats" })).not.toBeNull()
  })
})
