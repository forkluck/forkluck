// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveRecipeComment = vi.fn()

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipeComment: vi.fn(),
  removeRecipeShare: vi.fn(),
  saveRecipe: vi.fn(),
  saveRecipeAggregate: vi.fn(),
  saveRecipeComment: (...args: unknown[]) => saveRecipeComment(...args),
  shareRecipe: vi.fn(),
  updateRecipeShare: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  activateCatalogIngredient: vi.fn(),
  saveIngredient: vi.fn(),
  savePreparation: vi.fn(),
  saveRecipeLineMatch: vi.fn(),
  searchCatalogIngredients: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/new",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { PricingEntries, RecipeDetail } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  saveRecipeComment.mockReset()
})

const SOURCES = {
  items: [
    {
      id: "ing-flour",
      name: "Flour",
      normalizedName: "flour",
      measureName: "flour",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "kg",
      conversion: null,
      preparations: [],
      nutritionPer100g: null,
    },
  ],
  recipes: [],
} as unknown as PricingEntries

function saved(): RecipeDetail {
  return {
    id: "rec-1",
    publicId: "abc123",
    title: "Focaccia",
    description: "",
    status: "active",
    category: "",
    permission: "owner",
    canEdit: true,
    yieldAmount: null,
    yieldUnit: "pcs",
    servingAmount: null,
    servingUnit: "",
    shelfLifeAmount: null,
    shelfLifeUnit: "",
    prepTimeAmount: null,
    prepTimeUnit: "",
    autoSumYieldEnabled: false,
    autoPrepTimeEnabled: false,
    percentageMode: "",
    percentIngredientEnabled: false,
    percentIngredientType: "",
    items: [],
    steps: [],
    equivalency: null,
    tags: [],
    comments: [],
    ingredientOptions: [],
    recipeOptions: [],
  } as unknown as RecipeDetail
}

describe("the recipe comment button", () => {
  function editorScreen() {
    render(
      <RecipeChrome id="rec-1" publicId="abc123" title="Focaccia">
        <RecipeEditor
          currentUserId="user-1"
          initial={saved()}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )
  }

  it("stays enabled with an empty draft", () => {
    editorScreen()
    expect(
      (screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for text instead of saving", () => {
    editorScreen()
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    expect(saveRecipeComment).not.toHaveBeenCalled()
    expect(screen.getByText("Write a comment first.")).not.toBeNull()
  })

  it("saves once a comment is written", async () => {
    saveRecipeComment.mockResolvedValue({})
    editorScreen()
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "Looks great" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Comment" }))
    await act(async () => {})
    expect(saveRecipeComment).toHaveBeenCalledWith({
      recipeId: "rec-1",
      body: "Looks great",
    })
  })
})

describe("the quick-add line button", () => {
  function editorScreen() {
    render(
      <RecipeChrome title="New recipe">
        <RecipeEditor
          currentUserId="user-1"
          initial={null}
          sources={SOURCES}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )
  }

  it("stays enabled with an empty field", () => {
    editorScreen()
    expect(
      (screen.getByRole("button", { name: "Add line" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for an ingredient instead of adding a blank line", () => {
    editorScreen()
    fireEvent.click(screen.getByRole("button", { name: "Add line" }))
    expect(screen.queryAllByLabelText("Ingredient or recipe")).toHaveLength(0)
    expect(
      screen.getByText("Type an ingredient or recipe to add.")
    ).not.toBeNull()
  })

  it("adds a line once an ingredient is typed", async () => {
    editorScreen()
    fireEvent.change(screen.getByLabelText("Quick add ingredient"), {
      target: { value: "250 g Flour" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add line" }))
    await act(async () => {})
    expect(
      screen.queryAllByLabelText("Ingredient or recipe").length
    ).toBeGreaterThan(0)
  })
})
