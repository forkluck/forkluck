// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipeComment: vi.fn(),
  removeRecipeShare: vi.fn(),
  saveRecipe: vi.fn(),
  saveRecipeAggregate: vi.fn(),
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
  usePathname: () => "/recipes/rec-1",
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

type Use = {
  id: string
  publicId: string
  title: string
  status: "active" | "archived"
  quantity: number | null
  unit: string
}

function saved(usedIn: Use[]): RecipeDetail {
  return {
    id: "rec-1",
    publicId: "abc123",
    title: "Pastry cream",
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
    usedIn,
    ingredientOptions: [],
    recipeOptions: [],
  } as unknown as RecipeDetail
}

function editorScreen(usedIn: Use[]) {
  render(
    <RecipeChrome id="rec-1" publicId="abc123" title="Pastry cream">
      <RecipeEditor
        currentUserId="user-1"
        initial={saved(usedIn)}
        sources={{ items: [], recipes: [] }}
        categoryOptions={[]}
        tagOptions={[]}
      />
    </RecipeChrome>
  )
}

function usedIn() {
  return screen.getByRole("heading", { name: /Used in/ }).closest("section")!
}

afterEach(cleanup)

describe("Used in on the Recipe tab", () => {
  it("lists each recipe with its amount, and counts them", () => {
    editorScreen([
      {
        id: "r1",
        publicId: "rec_1",
        title: "Mille-feuille",
        status: "active",
        quantity: 2.5,
        unit: "cup",
      },
      {
        id: "r2",
        publicId: "rec_2",
        title: "Fruit tart",
        status: "active",
        quantity: null,
        unit: "",
      },
    ])

    const section = within(usedIn())
    expect(section.getByText("2")).not.toBeNull()
    const mille = section.getByRole("link", { name: /Mille-feuille/ })
    expect(mille.getAttribute("href")).toBe("/recipes/rec_1/recipe")
    expect(within(mille).getByText("2 1/2 cup")).not.toBeNull()
    expect(section.getByRole("link", { name: /Fruit tart/ }).textContent).toBe(
      "Fruit tart"
    )
  })

  it("sinks archived recipes to the bottom and marks them", () => {
    editorScreen([
      {
        id: "r1",
        publicId: "rec_1",
        title: "Retired tart",
        status: "archived",
        quantity: 1,
        unit: "cup",
      },
      {
        id: "r2",
        publicId: "rec_2",
        title: "Fruit tart",
        status: "active",
        quantity: 1,
        unit: "cup",
      },
    ])

    const section = within(usedIn())
    const titles = section
      .getAllByRole("link")
      .map((link) => link.textContent ?? "")
    expect(titles[0]).toContain("Fruit tart")
    expect(titles[1]).toContain("Retired tart")
    expect(section.getByText("Archived")).not.toBeNull()
  })

  it("says so when no recipe uses this one", () => {
    editorScreen([])

    const section = within(usedIn())
    expect(section.getByText("No recipe uses this yet.")).not.toBeNull()
    expect(section.queryAllByRole("link")).toHaveLength(0)
  })
})
