// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const batchState = vi.hoisted(() => ({ scale: 1 }))
const routerPush = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({
  updateRecipeCosting: vi.fn(),
  setRecipeItemExcludedFromCost: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  saveRecipeLineMatch: vi.fn(),
}))

const { registerSave, setDirty, setSaveState, toastAdd } = vi.hoisted(() => ({
  registerSave: vi.fn(),
  setDirty: vi.fn(),
  setSaveState: vi.fn(),
  toastAdd: vi.fn(),
}))

vi.mock("@/components/recipes/recipe-chrome", () => ({
  useRecipeEdit: () => ({
    batch: { label: "Custom", scale: batchState.scale, isOriginal: true },
    setBatch: vi.fn(),
    registerSave,
    setDirty,
    setSaveState,
  }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
    wagePerHourCents: 0,
    foodCostTarget: 0.3,
  }),
}))

import { RecipeCostView } from "@/components/recipes/recipe-cost-view"
import {
  setRecipeItemExcludedFromCost,
  updateRecipeCosting,
} from "@/app/(app)/recipes/actions"
import type { PriceListEntry } from "@/lib/pricing"
import type { WeighEquivalency } from "@/lib/recipe/weigh"

const updateRecipeCostingMock = vi.mocked(updateRecipeCosting)
const leftOutMock = vi.mocked(setRecipeItemExcludedFromCost)

const butter: PriceListEntry = {
  id: "butter",
  name: "Butter",
  normalizedName: "butter",
  purchaseCostCents: 500,
  purchaseSize: 100,
  purchaseUnit: "g",
}

type Line = {
  /** Defaults to the line's position, which is all any test needs. */
  itemId?: string
  kind: "ingredient" | "subrecipe"
  quantity: number | null
  unit: string
  displayName: string
  excludedFromCost: boolean
  targetId: string | null
  costCents: number | null
}

function costView(
  lines: Line[],
  priceList: PriceListEntry[] = [butter],
  recipeYield: { amount: number; unit: "g" | "pcs" } | null = {
    amount: 2,
    unit: "pcs",
  },
  serving: { amount: number | null; unit: string } = {
    amount: 1,
    unit: "pcs",
  },
  equivalency: WeighEquivalency | null = null,
  pricing: { canEditCosting?: boolean; menuPriceCents?: number | null } = {}
) {
  render(
    <RecipeCostView
      recipeId="rec-1"
      recipePublicId="rcp_recipe1"
      canEditCosting={pricing.canEditCosting ?? false}
      lines={lines.map((line, index) => ({
        ...line,
        itemId: line.itemId ?? `item-${index}`,
      }))}
      recipeYield={recipeYield}
      equivalency={equivalency}
      servingAmount={serving.amount}
      servingUnit={serving.unit}
      menuPriceCents={pricing.menuPriceCents ?? null}
      steps={[]}
      prepTimeSeconds={null}
      autoPrepTimeEnabled={false}
      priceList={priceList}
    />
  )
}

/** The figure on the right of the per-portion row with this label. */
function box(label: string): string {
  const value = screen.getByText(label).nextElementSibling
  const input = (
    value instanceof HTMLInputElement ? value : value?.querySelector("input")
  ) as HTMLInputElement | null
  if (input) {
    if (!input.value) return "–"
    if (label === "Food cost") return `${input.value}%`
    if (label === "Profit") {
      const amount = Number(input.value)
      return `${amount < 0 ? "-$" : "$"}${Math.abs(amount).toFixed(2)}`
    }
    return input.value
  }
  // The money rows carry a note under the figure; the figure comes first.
  return (value?.firstElementChild ?? value)?.textContent ?? ""
}

afterEach(() => {
  batchState.scale = 1
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  updateRecipeCostingMock.mockReset()
  updateRecipeCostingMock.mockResolvedValue({ ok: true })
  leftOutMock.mockReset()
  leftOutMock.mockResolvedValue({ ok: true, editVersion: 1 })
})

describe("the Suggested price box", () => {
  it("divides the portion cost by the food cost target", () => {
    // 100 g butter is $5.00 over 2 portions: $2.50 a portion, $8.33 at 30%.
    costView([
      {
        kind: "ingredient",
        quantity: 100,
        unit: "g",
        displayName: "butter",
        excludedFromCost: false,
        targetId: "butter",
        costCents: 500,
      },
    ])

    expect(box("Cost / portion")).toBe("$2.50")
    expect(box("Suggested at 30% food cost")).toBe("$8.33")
    expect(screen.getByText("Per portion")).not.toBeNull()
    expect(screen.queryByText("Recipe")).toBeNull()
  })

  it("shows a dash when nothing is costed yet", () => {
    costView([
      {
        kind: "ingredient",
        quantity: 100,
        unit: "g",
        displayName: "butter",
        excludedFromCost: true,
        targetId: "butter",
        costCents: 0,
      },
    ])

    expect(box("Suggested at 30% food cost")).toBe("–")
  })
})

describe("the food cost calculator", () => {
  const line: Line = {
    kind: "ingredient",
    quantity: 100,
    unit: "g",
    displayName: "butter",
    excludedFromCost: false,
    targetId: "butter",
    costCents: 500,
  }

  it("previews food cost and profit from the price being typed", () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    expect(
      screen.getByText("Set a sell price to calculate food cost and profit.")
    ).not.toBeNull()

    fireEvent.change(screen.getByLabelText("Sell price"), {
      target: { value: "10" },
    })

    expect(box("Food cost")).toBe("25.0%")
    expect(box("Profit")).toBe("$7.50")
    expect(
      screen.queryByText("Set a sell price to calculate food cost and profit.")
    ).toBeNull()
  })

  it("rejects zero without showing figures from the previously saved price", () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    fireEvent.change(screen.getByLabelText("Sell price"), {
      target: { value: "0" },
    })

    expect(
      screen.getByLabelText("Sell price").getAttribute("aria-invalid")
    ).toBe("true")
    expect(box("Food cost")).toBe("–")
    expect(box("Profit")).toBe("–")
    expect(
      screen.getByText("Sell price must be greater than $0.")
    ).not.toBeNull()
  })

  it("calls out a sell price below portion cost", () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 200,
    })

    expect(box("Food cost")).toBe("125.0%")
    expect(box("Profit")).toBe("-$0.50")
    expect(screen.getByText("Sell price is below portion cost.")).not.toBeNull()
  })

  it("uses and saves the suggested price", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Use $8.33" }))

    expect(
      (screen.getByLabelText("Sell price") as HTMLInputElement).value
    ).toBe("8.33")
    expect(box("Food cost")).toBe("30.0%")
    expect(box("Profit")).toBe("$5.83")
    await waitFor(() => {
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 1,
        servingUnit: "pcs",
        menuPriceCents: 833,
      })
    })
  })

  it("discloses when the calculator uses fractional-cent cost", () => {
    costView([{ ...line, costCents: 185 }])

    expect(box("Cost / portion")).toBe("$0.93")
    expect(screen.getByText("uses unrounded cost")).not.toBeNull()
  })

  it("matches the one-cookie acceptance calculation", () => {
    costView(
      [{ ...line, costCents: 269 }],
      [butter],
      { amount: 24, unit: "pcs" },
      { amount: 1, unit: "each" },
      null,
      { menuPriceCents: 200 }
    )

    expect(box("Cost / portion")).toBe("$0.11")
    expect(box("Food cost")).toBe("5.6%")
    expect(box("Profit")).toBe("$1.89")
  })

  it("lets food cost percentage drive and save a rounded sell price", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    const field = screen.getByLabelText("Food cost percentage")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "125" } })
    expect(
      (screen.getByLabelText("Sell price") as HTMLInputElement).value
    ).toBe("2.00")
    expect(box("Profit")).toBe("-$0.50")
    fireEvent.blur(field)

    await waitFor(() =>
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 1,
        servingUnit: "pcs",
        menuPriceCents: 200,
      })
    )
  })

  it("lets negative profit drive a below-cost positive sell price", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    const field = screen.getByLabelText("Profit dollars")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "-0.50" } })
    fireEvent.blur(field)

    await waitFor(() =>
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 1,
        servingUnit: "pcs",
        menuPriceCents: 200,
      })
    )
  })

  it("clearing a derived driver restores the saved sell price", () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    const field = screen.getByLabelText("Food cost percentage")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)

    expect(
      (screen.getByLabelText("Sell price") as HTMLInputElement).value
    ).toBe("5.00")
    expect(updateRecipeCostingMock).not.toHaveBeenCalled()
  })

  it("persists a cleared sell price as null", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    const field = screen.getByLabelText("Sell price")
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)

    await waitFor(() =>
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 1,
        servingUnit: "pcs",
        menuPriceCents: null,
      })
    )
  })
})

describe("yield and portion costs", () => {
  it("edits and atomically saves the commercial portion", async () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 500,
        },
      ],
      [butter],
      undefined,
      undefined,
      undefined,
      { canEditCosting: true, menuPriceCents: 500 }
    )

    const amount = screen.getByLabelText("Portion size amount")
    fireEvent.change(amount, { target: { value: "2" } })
    expect(box("Cost / portion")).toBe("$5.00")
    fireEvent.blur(amount)

    await waitFor(() =>
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 2,
        servingUnit: "pcs",
        menuPriceCents: 500,
      })
    )
  })

  it("does not save an incomplete commercial portion pair", () => {
    costView([], [], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    const amount = screen.getByLabelText("Portion size amount")
    fireEvent.change(amount, { target: { value: "" } })
    fireEvent.blur(amount)

    expect(updateRecipeCostingMock).not.toHaveBeenCalled()
    expect(
      screen.getByRole("img", {
        name: "Enter a positive portion amount and choose its unit.",
      })
    ).not.toBeNull()
  })

  it("tells the header why an incomplete portion cannot be saved", async () => {
    costView([], [], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    const amount = screen.getByLabelText("Portion size amount")
    fireEvent.change(amount, { target: { value: "" } })
    fireEvent.blur(amount)

    const headerSave = registerSave.mock.calls
      .map((call) => call[0])
      .filter(Boolean)
      .at(-1)!
    await headerSave()

    expect(updateRecipeCostingMock).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Enter a positive portion amount and choose its unit.",
      type: "error",
    })
  })

  it("does not invent a one-piece portion from a count yield", () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 500,
        },
      ],
      [butter],
      { amount: 8, unit: "pcs" },
      { amount: null, unit: "" }
    )

    expect(box("Portion size")).toBe("–")
    expect(box("Cost / portion")).toBe("–")
    expect(
      screen.getByText("Set a portion to calculate cost per portion.")
    ).not.toBeNull()
  })

  it("keeps the batch cost while requiring a total yield for unit cost", () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 500,
        },
      ],
      [butter],
      null,
      { amount: null, unit: "" }
    )

    expect(
      screen.getByText("Cost / batch").closest("tr")?.textContent
    ).toContain("$5.00")
    expect(
      screen.getByText("Cost per yield").closest("tr")?.textContent
    ).toContain("—")
    expect(
      screen.getByLabelText("Total yield needed for cost per yield")
    ).not.toBeNull()
    expect(box("Cost / portion")).toBe("–")
    expect(
      screen.getByText(
        "Set a total yield on the Recipe tab to calculate cost per unit and use this recipe as a sub-recipe."
      )
    ).not.toBeNull()
  })

  it("separates cost per yield unit from cost per portion", () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 500,
        },
      ],
      [butter],
      { amount: 250, unit: "g" },
      { amount: 25, unit: "g" }
    )

    const unitRow = screen.getByText("Cost per gram").closest("tr")
    expect(unitRow?.textContent).toContain("$0.02")
    expect(box("Portion size")).toBe("25 g")
    expect(box("Cost / portion")).toBe("$0.50")
  })

  it("requires an equivalency for a weighted portion of a counted yield", () => {
    batchState.scale = 2
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 356,
        },
      ],
      [butter],
      { amount: 31, unit: "pcs" },
      { amount: 12, unit: "g" },
      null,
      { canEditCosting: true, menuPriceCents: 200 }
    )

    expect(box("Portion size")).toBe("12")
    expect(
      screen.getByRole("button", { name: "Portion size unit" }).textContent
    ).toContain("g")
    expect(box("Cost / portion")).toBe("–")
    expect(
      screen.getByLabelText("Food cost percentage").hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByLabelText("Profit dollars").hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByText(/cannot be related to the total yield/i)
    ).not.toBeNull()
    expect(
      screen.getByRole("link", { name: "Open UOM" }).getAttribute("href")
    ).toBe("/recipes/rcp_recipe1/recipe#uom-equivalency")
  })

  it("leaves a cross-family portion unresolved without an equivalency", () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 185,
        },
      ],
      [butter],
      { amount: 600, unit: "g" },
      { amount: 1, unit: "each" }
    )

    expect(box("Cost / portion")).toBe("–")
    expect(
      screen.getByText(/cannot be related to the total yield/i)
    ).not.toBeNull()
  })

  it("offers direct access to UOM for a portion mismatch", () => {
    costView(
      [],
      [],
      { amount: 600, unit: "g" },
      { amount: 1, unit: "each" },
      null,
      { canEditCosting: true }
    )

    expect(
      screen.getByRole("link", { name: "Open UOM" }).getAttribute("href")
    ).toBe("/recipes/rcp_recipe1/recipe#uom-equivalency")
  })

  it("costs a counted portion through the batch UOM", () => {
    const equivalency = {
      massAmount: null,
      massUnit: "",
      volumeAmount: null,
      volumeUnit: "",
      countAmount: 100,
      countUnit: "each",
    }
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 185,
        },
      ],
      [butter],
      { amount: 600, unit: "g" },
      { amount: 1, unit: "each" },
      equivalency
    )

    expect(box("Cost / portion")).toBe("$0.02")
    expect(screen.queryByText(/cannot be related/i)).toBeNull()
  })

  it("keeps equivalency-resolved portion cost stable under a batch lens", () => {
    batchState.scale = 2
    costView(
      [
        {
          kind: "ingredient",
          quantity: 100,
          unit: "g",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: 185,
        },
      ],
      [butter],
      { amount: 600, unit: "g" },
      { amount: 1, unit: "each" },
      {
        massAmount: null,
        massUnit: "",
        volumeAmount: null,
        volumeUnit: "",
        countAmount: 100,
        countUnit: "each",
      }
    )

    expect(box("Cost / portion")).toBe("$0.02")
  })
})

describe("the Cost tab's re-parse", () => {
  it("routes a priced unit mismatch back to the Recipe tab", () => {
    costView(
      [
        {
          kind: "ingredient",
          quantity: 14,
          unit: "each",
          displayName: "butter",
          excludedFromCost: false,
          targetId: "butter",
          costCents: null,
        },
      ],
      [butter],
      undefined,
      undefined,
      undefined,
      { canEditCosting: true }
    )

    expect(screen.queryByText("Add price")).toBeNull()
    expect(
      screen.getByLabelText(
        "Butter is not measured in each. Change the recipe quantity or set a conversion on the ingredient."
      )
    ).not.toBeNull()
    expect(
      screen.getByRole("link", { name: "Open UOM" }).getAttribute("href")
    ).toBe("/recipes/rcp_recipe1/recipe#uom-equivalency")
  })

  it("lands the left-out flag on the line the cook marked", () => {
    costView([
      {
        kind: "ingredient",
        quantity: null,
        unit: "",
        displayName: "salt",
        excludedFromCost: false,
        targetId: null,
        costCents: null,
      },
      {
        kind: "ingredient",
        quantity: 100,
        unit: "g",
        displayName: "butter",
        excludedFromCost: true,
        targetId: "butter",
        costCents: 0,
      },
    ])

    // The flag went to the butter, not to the unmeasured line above it.
    expect(screen.getByText("Left out")).not.toBeNull()
    expect(box("Cost / portion")).toBe("$0.00")
  })

  it("includes a saved sub-recipe cost without a pantry price entry", () => {
    costView(
      [
        {
          kind: "subrecipe",
          quantity: 2,
          unit: "pcs",
          displayName: "Little Gem & Tender Herb Salad",
          excludedFromCost: false,
          targetId: "salad-recipe",
          costCents: 645,
        },
      ],
      []
    )

    expect(screen.getAllByText("$6.45").length).toBeGreaterThan(0)
    expect(box("Cost / portion")).toBe("$3.23")
    expect(screen.queryByText("No price yet")).toBeNull()
    expect(screen.getByText("Recipe")).not.toBeNull()
  })

  it("scales the saved sub-recipe contribution with the selected batch", () => {
    batchState.scale = 2
    costView(
      [
        {
          kind: "subrecipe",
          quantity: 2,
          unit: "pcs",
          displayName: "Little Gem & Tender Herb Salad",
          excludedFromCost: false,
          targetId: "salad-recipe",
          costCents: 645,
        },
      ],
      []
    )

    expect(screen.getAllByText("$12.90").length).toBeGreaterThan(0)
    // Yield scales with the same lens, so the per-portion cost is unchanged.
    expect(box("Cost / portion")).toBe("$3.23")
  })
})

describe("the sell price commit", () => {
  const line: Line = {
    kind: "ingredient",
    quantity: 100,
    unit: "g",
    displayName: "butter",
    excludedFromCost: false,
    targetId: "butter",
    costCents: 500,
  }

  it("hands the header its save and reports the write to the pill", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })
    expect(registerSave).toHaveBeenCalled()

    const field = screen.getByLabelText("Sell price")
    fireEvent.change(field, { target: { value: "10" } })
    fireEvent.blur(field)

    await waitFor(() =>
      expect(updateRecipeCostingMock).toHaveBeenCalledWith({
        recipeId: "rec-1",
        servingAmount: 1,
        servingUnit: "pcs",
        menuPriceCents: 1000,
      })
    )
    expect(setSaveState).toHaveBeenCalledWith("saving")
    await waitFor(() => expect(setSaveState).toHaveBeenCalledWith("saved"))
  })

  it("lets the registered header Save commit the combined draft", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })
    fireEvent.change(screen.getByLabelText("Sell price"), {
      target: { value: "10" },
    })

    const registered = registerSave.mock.calls.at(-1)?.[0]
    await registered?.()

    expect(updateRecipeCostingMock).toHaveBeenCalledWith({
      recipeId: "rec-1",
      servingAmount: 1,
      servingUnit: "pcs",
      menuPriceCents: 1000,
    })
  })

  it("goes back to the confirmed price when the server refuses", async () => {
    updateRecipeCostingMock.mockResolvedValue({ error: "Couldn’t save it." })
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
      menuPriceCents: 500,
    })

    const field = screen.getByLabelText("Sell price")
    fireEvent.change(field, { target: { value: "10" } })
    fireEvent.blur(field)

    await waitFor(() => expect((field as HTMLInputElement).value).toBe("5.00"))
    expect(setSaveState).toHaveBeenCalledWith("error")
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t save it.",
      type: "error",
    })
  })
})

describe("the left-out toggle", () => {
  const line: Line = {
    kind: "ingredient",
    quantity: 100,
    unit: "g",
    displayName: "butter",
    excludedFromCost: false,
    targetId: "butter",
    costCents: 500,
  }

  it("writes the flag for that line and marks the row at once", async () => {
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Actions for butter" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Leave out of cost" })
    )

    expect(leftOutMock).toHaveBeenCalledWith("rec-1", "item-0", true)
    await waitFor(() => expect(screen.getByText("Left out")).not.toBeNull())
    expect(screen.getByText("1 line left out")).not.toBeNull()
  })

  it("offers the way back on a line already left out", async () => {
    costView(
      [{ ...line, excludedFromCost: true, costCents: 0 }],
      [butter],
      undefined,
      undefined,
      undefined,
      { canEditCosting: true }
    )

    fireEvent.click(screen.getByRole("button", { name: "Actions for butter" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Count in cost" })
    )

    expect(leftOutMock).toHaveBeenCalledWith("rec-1", "item-0", false)
    await waitFor(() => expect(screen.queryByText("Left out")).toBeNull())
  })

  it("puts the row back and says so when the server refuses", async () => {
    leftOutMock.mockResolvedValue({ error: "Couldn’t change it." })
    costView([line], [butter], undefined, undefined, undefined, {
      canEditCosting: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Actions for butter" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Leave out of cost" })
    )

    await waitFor(() => expect(screen.queryByText("Left out")).toBeNull())
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t change it.",
      type: "error",
    })
  })

  it("is absent for a reader who cannot edit the costing", () => {
    costView([line])

    expect(screen.queryByRole("button", { name: "Actions for butter" })).toBe(
      null
    )
  })
})
