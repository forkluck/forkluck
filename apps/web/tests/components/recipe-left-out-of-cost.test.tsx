// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveRecipeAggregate = vi.fn()

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipeComment: vi.fn(),
  removeRecipeShare: vi.fn(),
  saveRecipe: vi.fn(),
  saveRecipeAggregate: (...args: unknown[]) => saveRecipeAggregate(...args),
  saveRecipeComment: vi.fn(),
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
  usePathname: () => "/recipes/rec-1/recipe",
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
import type { RecipeDetail } from "@/lib/backend/types"

const saved = {
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
  items: [
    {
      id: "item-1",
      kind: "ingredient",
      position: 0,
      displayName: "Sugar",
      quantity: 100,
      unit: "g",
      preparationNote: "",
      efficiency: 100,
      efficiencyAfterCooking: 100,
      isBase: false,
      excludedFromCost: false,
      ingredientId: null,
      subrecipeId: null,
      ingredientName: null,
      subrecipeName: null,
      resolved: true,
    },
  ],
  steps: [],
  equivalency: null,
  tags: [],
  comments: [],
  usedIn: [],
  ingredientOptions: [],
  recipeOptions: [],
} as unknown as RecipeDetail

function editorScreen() {
  render(
    <RecipeChrome id="rec-1" publicId="abc123" title="Focaccia">
      <RecipeEditor
        currentUserId="user-1"
        initial={saved}
        sources={{ items: [], recipes: [] }}
        categoryOptions={[]}
        tagOptions={[]}
      />
    </RecipeChrome>
  )
}

async function rowMenuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Actions for Sugar" }))
  return screen.findByRole("menuitem", { name })
}

afterEach(() => {
  cleanup()
  saveRecipeAggregate.mockReset()
})

describe("leaving a line out of cost", () => {
  it("is no longer offered on the recipe tab: the Cost tab owns it", async () => {
    editorScreen()

    expect(await rowMenuItem("Remove")).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Leave out of cost" })).toBe(
      null
    )
    expect(screen.queryByRole("menuitem", { name: "Count in cost" })).toBe(null)
  })

  it("still marks a row the Cost tab left out", async () => {
    render(
      <RecipeChrome id="rec-1" publicId="abc123" title="Focaccia">
        <RecipeEditor
          currentUserId="user-1"
          initial={
            {
              ...saved,
              items: [{ ...saved.items[0], excludedFromCost: true }],
            } as unknown as RecipeDetail
          }
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    )

    expect(screen.getByText("Not costed")).toBeTruthy()
  })
})
