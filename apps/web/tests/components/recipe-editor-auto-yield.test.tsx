// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

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
import type { PricingEntries } from "@/lib/backend/types"

afterEach(cleanup)

/** Pantry rows for the weighing cases below. */
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
    ...(
      [
        ["butter", "Butter"],
        ["egg-yolk", "Egg yolk"],
        ["powdered-sugar", "Powdered sugar"],
        ["powder-milk", "Powder Milk"],
        ["kosher-salt", "Kosher salt"],
      ] as const
    ).map(([id, name]) => ({
      id: `ing-${id}`,
      name,
      normalizedName: name.toLocaleLowerCase(),
      measureName: name,
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "kg",
      conversion: null,
      preparations: [],
      nutritionPer100g: null,
    })),
    {
      id: "ing-water",
      name: "Water",
      normalizedName: "water",
      measureName: "water",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "l",
      conversion: null,
      preparations: [],
      nutritionPer100g: null,
    },
    {
      id: "ing-large-eggs",
      name: "Large Eggs",
      normalizedName: "large eggs",
      measureName: "large eggs",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "each",
      conversion: {
        usesStandardConversion: false,
        source: "user",
        confidence: "high",
        weight: { amount: 64, unit: "g" },
        volume: null,
        each: { amount: 1, unit: "each" },
        updatedAt: new Date("2026-08-24T00:00:00Z"),
      },
      preparations: [],
      nutritionPer100g: null,
    },
    {
      id: "ing-stock",
      name: "Citrus Stock",
      normalizedName: "citrus stock",
      measureName: "citrus stock",
      purchaseCostCents: 0,
      purchaseSize: 1,
      purchaseUnit: "l",
      conversion: null,
      preparations: [],
      nutritionPer100g: null,
    },
  ],
  recipes: [],
} as unknown as PricingEntries

/** The same pantry, plus a component measured in cups and nothing else. */
const WITH_CURD = {
  ...SOURCES,
  recipes: [
    {
      id: "rec-curd",
      title: "Lemon Curd",
      body: "",
      kind: "component",
      yieldAmount: 2.75,
      yieldUnit: "cup",
      sellableYield: null,
      equivalency: null,
      category: null,
    },
  ],
} as unknown as PricingEntries

function editorScreen(sources: PricingEntries = SOURCES) {
  render(
    <RecipeChrome title="New recipe">
      <RecipeEditor
        currentUserId="user-1"
        initial={null}
        sources={sources}
        categoryOptions={[]}
        tagOptions={[]}
      />
    </RecipeChrome>
  )
}

// The quick add links the line before the row lands, so the row is awaited.
async function addLine(text: string) {
  fireEvent.change(screen.getByLabelText("Quick add ingredient"), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add line" }))
  await act(async () => {})
}

function autoCalculate() {
  fireEvent.click(
    screen.getByRole("switch", { name: /Auto-calculate total yield/ })
  )
}

async function chooseYieldUnit(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Total yield unit" }))
  fireEvent.click(await screen.findByText(name))
}

function yieldAmount() {
  return screen.getByLabelText("Total yield amount") as HTMLInputElement
}

describe("auto-calculated total yield", () => {
  it("does not exclude a standard-conversion line from batch weight", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await addLine("1 l Citrus Stock")

    expect(
      screen.queryByRole("img", {
        name: "Excluded from batch weight: Citrus Stock.",
      })
    ).toBeNull()
  })

  it("is disabled until a line can be weighed", async () => {
    editorScreen()

    expect(
      screen
        .getByRole("switch", { name: /Auto-calculate total yield/ })
        .getAttribute("data-disabled")
    ).not.toBeNull()

    await addLine("250 g Flour")

    expect(
      screen
        .getByRole("switch", { name: /Auto-calculate total yield/ })
        .getAttribute("data-disabled")
    ).toBeNull()
  })

  it("shows the weighed sum read-only in the chosen weight unit", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await addLine("150 g Water")

    autoCalculate()
    await chooseYieldUnit("Gram")

    expect(yieldAmount().value).toBe("400")
    expect(yieldAmount().disabled).toBe(true)
    // The unit stays the cook's to change.
    expect(
      (
        screen.getByRole("button", {
          name: "Total yield unit",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("infers grams for a weight-only formula", async () => {
    editorScreen()
    await addLine("500 g Flour")
    await addLine("250 g Butter")
    await addLine("100 g Egg yolk")
    await addLine("150 g Powdered sugar")
    await addLine("50 g Powder Milk")
    await addLine("5 g Kosher salt")

    autoCalculate()

    expect(yieldAmount().value).toBe("1055")
    expect(
      screen.getByRole("button", { name: "Total yield unit" }).textContent
    ).toContain("g")
    expect(
      screen.queryByRole("button", {
        name: "Needs gram to each on the ingredient",
      })
    ).toBeNull()
  })

  it("defaults a volume-only formula to grams", async () => {
    editorScreen()
    await addLine("500 ml Water")

    autoCalculate()

    expect(yieldAmount().value).toBe("500.02")
    expect(
      screen.getByRole("button", { name: "Total yield unit" }).textContent
    ).toContain("g")
  })

  it("defaults a count-only formula to grams through its each weight", async () => {
    editorScreen()
    await addLine("12 ea Large Eggs")

    autoCalculate()

    expect(yieldAmount().value).toBe("768")
    expect(
      screen.queryByRole("button", {
        name: "Needs each to gram on the ingredient",
      })
    ).toBeNull()
  })

  it("names a missing each-to-gram conversion", async () => {
    editorScreen()
    await addLine("12 ea Egg yolk")

    autoCalculate()

    expect(yieldAmount().value).toBe("")
    expect(
      screen.getByRole("button", {
        name: "Needs each to gram on the ingredient",
      })
    ).not.toBeNull()
  })

  it("defaults a mixed formula to one gram-based total", async () => {
    editorScreen()
    await addLine("500 g Flour")
    await addLine("500 ml Water")
    await addLine("5 g Kosher salt")

    autoCalculate()

    expect(yieldAmount().value).toBe("1005.02")
  })

  it("converts an unknown standard ingredient between weight and volume", async () => {
    editorScreen()
    await addLine("8 oz Citrus Stock")
    await chooseYieldUnit("Milliliter")
    autoCalculate()

    expect(yieldAmount().value).toBe("236.59")
    expect(
      screen.queryByRole("button", {
        name: "Needs ounce to milliliter on the ingredient",
      })
    ).toBeNull()
  })

  it("brings back the typed yield and lets it be typed again once it is off", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await addLine("150 g Water")
    await chooseYieldUnit("Gram")
    fireEvent.change(yieldAmount(), { target: { value: "300" } })
    autoCalculate()
    expect(yieldAmount().value).toBe("400")

    autoCalculate()

    expect(yieldAmount().value).toBe("300")
    expect(yieldAmount().disabled).toBe(false)
  })

  it("asks each ingredient for pieces when the yield is counted", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await chooseYieldUnit("Pieces")

    autoCalculate()

    expect(yieldAmount().value).toBe("")
    expect(
      screen.getByText(
        "Link every ingredient and give each one a conversion to each to auto-calculate."
      )
    ).not.toBeNull()
    expect(
      screen.getByRole("button", {
        name: "Needs gram to each on the ingredient",
      })
    ).not.toBeNull()
  })

  it("shows a dash and flags the line that cannot be weighed", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await addLine("2 pcs Mystery")

    autoCalculate()
    await chooseYieldUnit("Gram")

    expect(yieldAmount().value).toBe("")
    expect(
      screen.getByText(
        "Link every ingredient and give each one a conversion to gram to auto-calculate."
      )
    ).not.toBeNull()
    // The name field's own unlinked flag covers the row; no second triangle.
    expect(screen.queryByRole("button", { name: "Not linked" })).toBeNull()
  })

  it("names the sub-recipe that has to state a weight", async () => {
    editorScreen(WITH_CURD)
    await addLine("1 cup Lemon Curd")

    autoCalculate()
    await chooseYieldUnit("Gram")

    expect(yieldAmount().value).toBe("")
    expect(
      screen.getByRole("button", {
        name: "Add a weight to Lemon Curd's UOM",
      })
    ).not.toBeNull()
  })

  it("asks a blank automatic yield for the sub-recipe's weight", async () => {
    editorScreen(WITH_CURD)
    await addLine("1 cup Lemon Curd")

    autoCalculate()

    expect(
      screen.getByRole("button", {
        name: "Add a weight to Lemon Curd's UOM",
      })
    ).not.toBeNull()
  })
})

describe("the auto-calculated yield under a batch lens", () => {
  it("shows the sum multiplied while the recipe keeps it at 1x", async () => {
    editorScreen()
    await addLine("250 g Flour")
    await addLine("150 g Water")
    autoCalculate()
    await chooseYieldUnit("Gram")

    fireEvent.click(screen.getByRole("button", { name: "Batch size" }))
    fireEvent.click(await screen.findByText("2x"))

    expect(yieldAmount().value).toBe("800")

    fireEvent.click(screen.getByRole("button", { name: "Batch size" }))
    fireEvent.click(await screen.findByText("1x"))

    expect(yieldAmount().value).toBe("400")
  })
})
