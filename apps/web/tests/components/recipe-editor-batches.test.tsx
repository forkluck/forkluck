// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  usePathname: () => "/recipes/abc123/recipe",
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

import { NavigationBlockerProvider } from "@/components/navigation-blocker"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"
import type { RecipeDetail } from "@/lib/backend/types"

/** A saved recipe that keeps one custom batch beside the built-ins. */
const SAVED = {
  id: "rec-1",
  publicId: "abc123",
  title: "Pastry Cream",
  description: "",
  status: "active",
  category: "",
  permission: "owner",
  canEdit: true,
  yieldAmount: 2.5,
  yieldUnit: "cup",
  servingAmount: null,
  servingUnit: "",
  shelfLifeAmount: null,
  shelfLifeUnit: "",
  autoSumYieldEnabled: false,
  percentageMode: "",
  percentIngredientEnabled: false,
  percentIngredientType: "",
  items: [],
  steps: [],
  batchSizes: [{ id: "b1", label: "4x", scale: 4, isOriginal: false }],
  equivalency: null,
  tags: [],
  comments: [],
  ingredientOptions: [],
  recipeOptions: [],
} as unknown as RecipeDetail

function editorScreen() {
  render(
    <NavigationBlockerProvider>
      <RecipeChrome id={SAVED.id} publicId={SAVED.publicId} title={SAVED.title}>
        <RecipeEditor
          currentUserId="user-1"
          initial={SAVED}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    </NavigationBlockerProvider>
  )
}

function editorWithEquivalency(standard = false) {
  const recipe = {
    ...SAVED,
    equivalency: {
      id: "eq-1",
      massAmount: standard ? 8 : 700,
      massUnit: standard ? "oz" : "g",
      volumeAmount: standard ? 1 : null,
      volumeUnit: standard ? "cup" : "",
      countAmount: null,
      countUnit: "",
      standard,
    },
  } as unknown as RecipeDetail
  render(
    <NavigationBlockerProvider>
      <RecipeChrome
        id={recipe.id}
        publicId={recipe.publicId}
        title={recipe.title}
      >
        <RecipeEditor
          currentUserId="user-1"
          initial={recipe}
          sources={{ items: [], recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    </NavigationBlockerProvider>
  )
}

beforeEach(() => {
  saveRecipeAggregate.mockResolvedValue({
    id: "rec-1",
    publicId: "abc123",
    code: "R1",
  })
})

afterEach(() => {
  cleanup()
  saveRecipeAggregate.mockReset()
})

describe("custom batches", () => {
  it("lists the kept batch beside the built-ins", async () => {
    editorScreen()
    fireEvent.click(screen.getByLabelText("Batch size"))
    expect(await screen.findByText("4x")).toBeTruthy()
  })

  it("rides along on a save it had nothing to do with", async () => {
    editorScreen()
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Silky." },
    })
    await vi.waitFor(
      () => expect(saveRecipeAggregate).toHaveBeenCalledTimes(1),
      { timeout: 4500 }
    )
    expect(saveRecipeAggregate.mock.calls[0][0].batchSizes).toEqual([
      { label: "1x", scale: 1, isOriginal: true },
      { label: "4x", scale: 4, isOriginal: false },
    ])
  })

  it("removes a kept batch and saves the recipe without it", async () => {
    editorScreen()
    fireEvent.click(screen.getByLabelText("Batch size"))
    fireEvent.click(await screen.findByLabelText("Remove 4x"))
    await vi.waitFor(
      () => expect(saveRecipeAggregate).toHaveBeenCalledTimes(1),
      { timeout: 4500 }
    )
    expect(saveRecipeAggregate.mock.calls[0][0].batchSizes).toEqual([])
    fireEvent.click(screen.getByLabelText("Batch size"))
    expect(screen.queryByText("4x")).toBeNull()
  })
})

describe("UOM", () => {
  it("shows and locks the declared yield while accepting another UOM", () => {
    editorWithEquivalency()

    expect(screen.getByText("UOM")).not.toBeNull()
    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).value
    ).toBe("2.5")
    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).disabled
    ).toBe(true)
    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).disabled
    ).toBe(false)
    expect(
      screen.getByText(
        (_content, element) => element?.textContent === "Batch weight ≈ 700 g"
      )
    ).not.toBeNull()
  })

  it("keeps both sides of a standard density ratio editable", () => {
    editorWithEquivalency(true)

    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).value
    ).toBe("8")
    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).value
    ).toBe("1")
    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).disabled
    ).toBe(false)
    expect(screen.getByLabelText("What the batch UOM means")).not.toBeNull()
  })

  it("scales the whole-batch equivalency while keeping its saved 1x basis", async () => {
    editorWithEquivalency()

    fireEvent.click(screen.getByLabelText("Batch size"))
    fireEvent.click(await screen.findByText("2x"))

    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).value
    ).toBe("5")
    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).value
    ).toBe("1400")

    fireEvent.change(screen.getByLabelText("Weight amount"), {
      target: { value: "1600" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(saveRecipeAggregate).toHaveBeenCalled())
    expect(
      saveRecipeAggregate.mock.calls.at(-1)?.[0].equivalency?.massAmount
    ).toBe(800)
  })
})
