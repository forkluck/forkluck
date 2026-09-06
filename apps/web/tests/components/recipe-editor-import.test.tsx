// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
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
  searchCatalogIngredients: vi.fn(),
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

import {
  activateCatalogIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { PricingEntries } from "@/lib/backend/types"

const searchMock = vi.mocked(searchCatalogIngredients)
const activateMock = vi.mocked(activateCatalogIngredient)

/** One pantry row with a preparation, and one saved component recipe. */
const SOURCES = {
  items: [
    {
      id: "ing-egg",
      name: "Egg",
      normalizedName: "egg",
      measureName: "egg",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "kg",
      conversion: null,
      preparations: [{ id: "prep-large", name: "large" }],
      nutritionPer100g: null,
    },
  ],
  recipes: [{ id: "rec-curd", title: "Lemon Curd" }],
} as unknown as PricingEntries

beforeEach(() => {
  vi.clearAllMocks()
  searchMock.mockResolvedValue({
    items: [
      {
        id: "cat-juice",
        name: "Lemon juice",
        preparations: [],
        aliases: [],
      },
    ],
  })
  activateMock.mockResolvedValue({
    id: "pantry-juice",
    name: "Lemon juice",
    created: true,
    preparations: [],
  })
})

afterEach(cleanup)

function importList(text: string) {
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
  // The ingredient table's own paste button, not the prep method's.
  fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[0])
  fireEvent.change(screen.getByLabelText("Ingredients"), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
}

function importDocument(text: string) {
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
  fireEvent.click(screen.getByRole("button", { name: "Actions" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Import recipe…" }))
  fireEvent.paste(screen.getByLabelText("Ingredients"), {
    clipboardData: { getData: () => text },
  })
  fireEvent.click(screen.getByRole("button", { name: "Import" }))
}

function names() {
  return (
    screen.getAllByLabelText("Ingredient or recipe") as HTMLInputElement[]
  ).map((one) => one.value)
}

describe("importing an ingredient list", () => {
  it("links each line to the pantry, the catalog and the cook's recipes", async () => {
    importList("3 large eggs\n1 cup lemon juice\n2 3/4 cups Lemon Curd")

    await screen.findByDisplayValue("Lemon juice")
    // "large" is a saved preparation of Egg, so the field reads them together.
    expect(names()).toEqual(["Egg, large", "Lemon juice", "Lemon Curd"])
    expect(activateMock).toHaveBeenCalledWith("cat-juice")
    // Every line found a home, so no line is flagged.
    expect(
      screen.queryAllByRole("button", {
        name: "Not linked: pick an ingredient or recipe",
      })
    ).toHaveLength(0)
    expect(
      (screen.getAllByLabelText("Notes") as HTMLInputElement[])[0].value
    ).toBe("")
  })

  it("leaves a name nothing answers as written", async () => {
    searchMock.mockResolvedValue({ items: [] })
    importList("2 cups popo")

    await screen.findByDisplayValue("popo")
    expect(
      screen.queryAllByRole("button", {
        name: "Not linked: pick an ingredient or recipe",
      })
    ).toHaveLength(1)
  })
})

describe("importing a whole recipe", () => {
  it("turns one pasted document into rows and steps", async () => {
    importDocument(
      "3 large eggs\n1 cup lemon juice\n\nMethod:\n" +
        "Whisk the eggs with the juice.\n> Chill the tart before slicing."
    )

    await screen.findByDisplayValue("Lemon juice")
    expect(names()).toEqual(["Egg, large", "Lemon juice"])
    expect(
      (screen.getByLabelText("Step 1 body") as HTMLTextAreaElement).value
    ).toBe("Whisk the eggs with the juice.")
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "Chill the tart before slicing."
    )
  })
})
