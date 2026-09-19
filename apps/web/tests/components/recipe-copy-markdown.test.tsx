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

const toastAdd = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
  }),
}))

import { searchCatalogIngredients } from "@/app/(app)/ingredients/actions"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome, useRecipeEdit } from "@/components/recipes/recipe-chrome"
import type { PricingEntries } from "@/lib/backend/types"

const SOURCES = { items: [], recipes: [] } as unknown as PricingEntries

const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(searchCatalogIngredients).mockResolvedValue({ items: [] })
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
})

afterEach(cleanup)

/** A new recipe with a pasted list, the way the import test builds one. */
function recipeWith(text: string) {
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
  fireEvent.click(screen.getAllByRole("button", { name: "+ Add" })[0])
  fireEvent.change(screen.getByLabelText("Ingredients"), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
}

async function copyFromMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }))
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: "Copy as MD",
    })
  )
}

/** A tab with no lines of its own, like Cost or Nutrition. */
function BatchOnly() {
  const { batch } = useRecipeEdit()
  return <output>{batch.label}</output>
}

describe("copying the recipe as markdown", () => {
  it("writes the recipe to the clipboard, title first, as the importer reads it", async () => {
    recipeWith(
      ["# Dough", "500 g bread flour", "1 1/2 cup water, lukewarm"].join("\n")
    )
    await screen.findByDisplayValue("water")
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })

    await copyFromMenu()

    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [
          "# Focaccia",
          "",
          "## Dough",
          "- 500 g bread flour",
          "- 1 1/2 cup water, lukewarm",
        ].join("\n")
      )
    )
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({ title: "Copied as markdown" })
    )
  })

  it("says when the clipboard refused rather than pretending it copied", async () => {
    writeText.mockRejectedValue(new Error("denied"))
    recipeWith("500 g bread flour")
    await screen.findByDisplayValue("bread flour")

    await copyFromMenu()

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn’t copy", type: "error" })
      )
    )
  })

  it("says there is nothing to copy on a recipe with no lines yet", async () => {
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

    await copyFromMenu()

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({ title: "Nothing to copy yet" })
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it("points at the Recipe tab from a tab that has no lines", async () => {
    render(
      <RecipeChrome id="rec-1" title="Focaccia" publicId="rcp_1" canViewCost>
        <BatchOnly />
      </RecipeChrome>
    )

    await copyFromMenu()

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Open the Recipe tab to copy it",
      })
    )
    expect(writeText).not.toHaveBeenCalled()
  })
})
