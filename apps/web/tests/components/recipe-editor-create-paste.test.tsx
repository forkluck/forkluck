// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

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

import { NavigationBlockerProvider } from "@/components/navigation-blocker"
import { RecipeEditor } from "@/components/recipe-editor"
import { RecipeChrome } from "@/components/recipes/recipe-chrome"

type SourceItem = React.ComponentProps<
  typeof RecipeEditor
>["sources"]["items"][number]

function pantryEntry(
  partial: Partial<SourceItem> & { id: string }
): SourceItem {
  return {
    name: "Flour",
    normalizedName: "flour",
    measureName: "flour",
    status: "active",
    nonEdible: false,
    purchaseCostCents: 500,
    purchaseSize: 1000,
    purchaseUnit: "g",
    yieldPercent: 100,
    conversion: null,
    preparations: [],
    nutritionPer100g: null,
    ...partial,
  }
}

function newRecipeScreen(items: SourceItem[] = []) {
  render(
    <NavigationBlockerProvider>
      <RecipeChrome title="New recipe">
        <RecipeEditor
          currentUserId="user-1"
          initial={null}
          sources={{ items, recipes: [] }}
          categoryOptions={[]}
          tagOptions={[]}
        />
      </RecipeChrome>
    </NavigationBlockerProvider>
  )
}

async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

const LIST =
  "500 g bread flour\n400 g water\n10 g salt\n8 g instant yeast\n40 g olive oil"

beforeEach(() => {
  vi.useFakeTimers()
  window.history.replaceState(null, "", "/recipes/new")
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  saveRecipeAggregate.mockReset()
})

describe("pasting a list while the first save creates the recipe", () => {
  it("keeps every pasted row when the create lands mid-paste", async () => {
    let finish: ((profile: unknown) => void) | null = null
    saveRecipeAggregate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    newRecipeScreen()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    // Moving on to the lines commits the name: the first save is in flight.
    fireEvent.blur(screen.getByLabelText("Name (required)"))
    await settle(0)
    expect(saveRecipeAggregate).toHaveBeenCalledTimes(1)

    fireEvent.paste(screen.getByLabelText("Quick add ingredient"), {
      clipboardData: { getData: () => LIST },
    })
    // Two lines land, then the create comes back mid-loop.
    await act(async () => {})
    await act(async () => {})
    await act(async () => {
      finish?.({ id: "rec-9", publicId: "rcp_focaccia", code: "R9" })
    })
    await settle(0)
    await act(async () => {})
    await settle(3000)

    const rows = screen.getAllByLabelText("Ingredient or recipe")
    expect(rows.map((row) => (row as HTMLInputElement).value)).toEqual([
      "bread flour",
      "water",
      "salt",
      "instant yeast",
      "olive oil",
    ])
    // The URL holds still while rows are unsaved: a pathname swap makes Next
    // rebuild the screen from the server, which would drop them.
    expect(window.location.pathname).toBe("/recipes/new")

    // The quiet save carries the rows; only then does the URL follow.
    await settle(3000)
    await act(async () => {
      finish?.({ id: "rec-9", publicId: "rcp_focaccia", code: "R9" })
    })
    await settle(0)
    expect(window.location.pathname).toBe("/recipes/rcp_focaccia/recipe")
  })

  it("does not link a pasted line to a supply", async () => {
    saveRecipeAggregate.mockResolvedValue({
      id: "rec-9",
      publicId: "rcp_focaccia",
      code: "R9",
    })
    newRecipeScreen([
      pantryEntry({
        id: "sup-1",
        name: "Takeout box",
        normalizedName: "takeout box",
        measureName: "takeout box",
        nonEdible: true,
      }),
    ])

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    fireEvent.paste(screen.getByLabelText("Quick add ingredient"), {
      clipboardData: { getData: () => "1 each takeout box\n250 g flour" },
    })
    for (let i = 0; i < 12; i += 1) await act(async () => {})
    await settle(3000)

    const items = saveRecipeAggregate.mock.calls.flatMap(
      (call) =>
        (call.at(-1) as { items?: { ingredientId: string | null }[] }).items ??
        []
    )
    expect(items).not.toHaveLength(0)
    expect(items.map((one) => one.ingredientId)).not.toContain("sup-1")
  })

  it("keeps every pasted row when the create lands after the loop", async () => {
    let finish: ((profile: unknown) => void) | null = null
    saveRecipeAggregate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    newRecipeScreen()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Focaccia" },
    })
    await settle(0)

    fireEvent.paste(screen.getByLabelText("Quick add ingredient"), {
      clipboardData: { getData: () => LIST },
    })
    for (let i = 0; i < 12; i += 1) await act(async () => {})
    await act(async () => {
      finish?.({ id: "rec-9", publicId: "rcp_focaccia", code: "R9" })
    })
    await settle(3000)

    expect(screen.getAllByLabelText("Ingredient or recipe")).toHaveLength(5)
  })
})
