// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  adoptCatalogPrice: vi.fn(),
  adoptMasterPrice: vi.fn(),
  dismissMasterPrice: vi.fn(),
  saveIngredient: vi.fn(),
  saveRecipeLineMatch: vi.fn(),
  linkInvoiceItem: vi.fn(),
  searchCatalogPrices: vi.fn(async () => ({ items: [] })),
}))

vi.mock("@/components/ingredients/ingredient-form", () => ({
  IngredientForm: () => null,
}))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "metric",
    wagePerHourCents: 2000,
  }),
}))

import { RecipeCostingPanel } from "@/components/recipes/recipe-panels"
import { computeCostBreakdown, type CostBreakdown } from "@/lib/benchcost/math"
import { priceParsedLines, type PriceListEntry } from "@/lib/pricing"
import { parseRecipeText } from "@/lib/recipe"
import type { IngredientMeasure, ParsedRecipeLine } from "@/lib/recipe"

const bakingPowder: PriceListEntry = {
  id: "baking-powder",
  name: "Baking powder",
  normalizedName: "baking powder",
  purchaseCostCents: 400,
  purchaseSize: 450,
  purchaseUnit: "g",
}

const butter: PriceListEntry = {
  id: "butter",
  name: "Butter",
  normalizedName: "butter",
  purchaseCostCents: 500,
  purchaseSize: 100,
  purchaseUnit: "g",
}

const teaspoonOfBakingPowder: IngredientMeasure = {
  id: "baking-powder-tsp",
  ingredientId: "baking-powder",
  name: "Baking powder",
  normalizedName: "baking powder",
  unit: "tsp",
  amount: 1,
  grams: 4.4,
  lowGrams: null,
  highGrams: null,
  qualifier: "",
  source: "user",
  confidence: "high",
}

function renderPanel(
  body: string,
  {
    priceList = [] as PriceListEntry[],
    measures = [] as IngredientMeasure[],
    extraLines = [] as ParsedRecipeLine[],
    yieldAmount = null as number | null,
    yieldWord = null as string | null,
    canPrice = true,
    labor = null as CostBreakdown | null,
    leftOut = [] as number[],
    fixUnitHref = "/recipes/rcp_1/recipe#uom-equivalency",
    onToggleLeftOut = undefined as
      ((index: number, leftOut: boolean) => void) | undefined,
  } = {}
) {
  const parsed = parseRecipeText(body, { identities: priceList, measures })
  const lines = [...parsed.parsedLines, ...extraLines].map((line, index) =>
    leftOut.includes(index) ? { ...line, excludedFromCost: true } : line
  )
  const pricing = priceParsedLines(lines, priceList)
  render(
    <RecipeCostingPanel
      lines={lines}
      priced={pricing.lines}
      totalCents={pricing.totalCents}
      yieldAmount={yieldAmount}
      yieldWord={yieldWord}
      labor={labor}
      priceList={priceList}
      onLinked={vi.fn()}
      fixUnitHref={fixUnitHref}
      canPrice={canPrice}
      onToggleLeftOut={onToggleLeftOut}
    />
  )
  return { lines, pricing }
}

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name)
  const row = cell.closest("tr")
  if (!row) throw new Error(`No row for ${name}`)
  return row
}

function cents(text: string): number {
  return Math.round(Number.parseFloat(text.replace(/[^0-9.]/g, "")) * 100)
}

/** A row the cook wrote without an amount, which prices nothing. */
const forBrushing: ParsedRecipeLine = {
  kind: "ingredient",
  lineNumber: 99,
  rawLine: "olive oil, for brushing",
  enteredAmount: 0,
  enteredUnit: null,
  normalizedUnit: null,
  ingredientName: "olive oil",
  baseName: "olive oil",
  sizeWord: null,
  identityCandidates: ["olive oil", "oil"],
  qualifier: null,
  noteText: "for brushing",
  amountRange: null,
  equivalent: null,
  alert: "unmeasured",
  note: null,
  ingredient: null,
  componentQuantity: null,
  identityMatched: false,
  resolutionSource: null,
  measureRange: null,
}

afterEach(cleanup)

describe("RecipeCostingPanel quantities", () => {
  it("shows the entered measure with the resolved weight beside it", () => {
    renderPanel("0.25 tsp baking powder", {
      priceList: [bakingPowder],
      measures: [teaspoonOfBakingPowder],
    })
    const row = rowFor("baking powder")
    expect(within(row).getByText("0.25 tsp")).toBeTruthy()
    expect(within(row).getByText("≈ 1.1 g")).toBeTruthy()
  })

  it("leaves a line written by weight as the weight alone", () => {
    renderPanel("225 g butter", { priceList: [butter] })
    const row = rowFor("butter")
    expect(within(row).getByText("225 g")).toBeTruthy()
    expect(within(row).queryByText(/≈/)).toBeNull()
  })

  it("shows a dash for a row with no amount", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      extraLines: [forBrushing],
    })
    expect(within(rowFor("olive oil")).getByText("—")).toBeTruthy()
  })
})

describe("RecipeCostingPanel totals", () => {
  it("rounds once after adding the unrounded line costs", () => {
    renderPanel("49.5 g butter\n49.5 g butter", { priceList: [butter] })
    const lineCosts = screen
      .getAllByTitle("Replace where this price comes from")
      .map((button) => cents(button.textContent ?? ""))
    expect(lineCosts).toEqual([248, 248])

    const total = rowFor("Ingredient cost / batch")
    expect(cents(total.textContent ?? "")).toBe(495)
    expect(cents(rowFor("Cost / batch").textContent ?? "")).toBe(495)
  })

  it("ends the row costs on the same column as the totals", () => {
    renderPanel("100 g butter", {
      priceList: [butter],
      onToggleLeftOut: vi.fn(),
    })

    const cost = screen
      .getByTitle("Replace where this price comes from")
      .closest("td")!
    const total = within(rowFor("Ingredient cost / batch"))
      .getByText("$5.00")
      .closest("td")!
    expect(cost).toBe(cost.parentElement?.lastElementChild)
    expect(total).toBe(total.parentElement?.lastElementChild)
    // The `…` overlays that column instead of holding one of its own.
    expect(
      within(cost).getByRole("button", { name: "Actions for butter" })
    ).toBeTruthy()
  })

  it("names the yield unit the per-unit row divides into", () => {
    renderPanel("49.5 g butter\n49.5 g butter", {
      priceList: [butter],
      yieldAmount: 8,
      yieldWord: "slice",
    })
    expect(cents(rowFor("Cost per slice").textContent ?? "")).toBe(62)
  })

  it("shows the true unit cost instead of the cost of a weighted portion", () => {
    renderPanel("49.5 g butter\n49.5 g butter", {
      priceList: [butter],
      yieldAmount: 250,
      yieldWord: "gram",
    })
    expect(cents(rowFor("Cost per gram").textContent ?? "")).toBe(2)
  })

  it("falls back to the plain word when nothing names the yield", () => {
    renderPanel("49.5 g butter", { priceList: [butter], yieldAmount: 2 })
    expect(rowFor("Cost per unit")).toBeTruthy()
  })

  it("shows why cost per yield is unavailable without hiding batch cost", () => {
    renderPanel("100 g butter", { priceList: [butter] })

    expect(cents(rowFor("Cost / batch").textContent ?? "")).toBe(500)
    expect(within(rowFor("Cost per yield")).getByText("—")).toBeTruthy()
    expect(
      screen.getByLabelText("Total yield needed for cost per yield")
    ).toBeTruthy()
  })

  it("says a line has no price yet when the reader cannot add one", () => {
    // Without a picker to open, an empty cost cell read as a rendering fault.
    renderPanel("225 g butter\n100 g cocoa powder", {
      priceList: [butter],
      canPrice: false,
    })
    expect(
      within(rowFor("cocoa powder")).getByText("No price yet")
    ).toBeTruthy()
    expect(
      screen.queryByTitle("Replace where this price comes from")
    ).toBeNull()
    expect(within(rowFor("butter")).getByText("$11.25")).toBeTruthy()
  })

  it("counts only priceable rows as missing a price", () => {
    renderPanel("225 g butter\n100 g cocoa powder", {
      priceList: [butter],
      extraLines: [forBrushing],
    })
    expect(within(rowFor("olive oil")).getByText("—")).toBeTruthy()
    expect(within(rowFor("cocoa powder")).getByText("Add price")).toBeTruthy()
    expect(
      within(rowFor("cocoa powder")).getByLabelText("No price yet")
    ).toBeTruthy()
    expect(within(rowFor("butter")).queryByLabelText("No price yet")).toBeNull()
    expect(
      within(rowFor("olive oil")).queryByLabelText("No price yet")
    ).toBeNull()
    expect(screen.queryByText(/so this cost is partial/)).toBeNull()
  })
})

/** A pantry row the cook named but never said what they buy it as. */
const unpricedCocoa: PriceListEntry = {
  id: "cocoa-powder",
  name: "Cocoa powder",
  normalizedName: "cocoa powder",
  purchaseCostCents: 0,
  purchaseSize: null,
  purchaseUnit: null,
}

/** Priced, but by the piece, so a line written in grams still costs nothing. */
const eggs: PriceListEntry = {
  id: "eggs",
  name: "Eggs",
  normalizedName: "eggs",
  purchaseCostCents: 400,
  purchaseSize: 12,
  purchaseUnit: "each",
}

/** Opens whatever the cost cell offers: "Add price" or the money itself. */
function openCostCell(name: string) {
  fireEvent.click(
    within(rowFor(name)).getByTitle("Replace where this price comes from")
  )
}

describe("RecipeCostingPanel add price", () => {
  it("asks for a unit fix when the ingredient is priced in another family", () => {
    renderPanel("14 ea butter", { priceList: [butter] })
    const row = rowFor("butter")

    expect(within(row).queryByText("Add price")).toBeNull()
    expect(
      within(row).getByLabelText(
        "Butter is not measured in ea. Change the recipe quantity or set a conversion on the ingredient."
      )
    ).toBeTruthy()
    expect(
      within(row).getByRole("link", { name: "Open UOM" }).getAttribute("href")
    ).toBe("/recipes/rcp_1/recipe#uom-equivalency")
  })

  it("asks for the pack when the match is one nobody has priced", () => {
    renderPanel("100 g cocoa powder", { priceList: [unpricedCocoa] })
    openCostCell("cocoa powder")

    expect(screen.getByLabelText("Cost (USD)")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Change match" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
    expect(screen.queryByLabelText("Search pricing choices")).toBeNull()
  })

  it("prices the match the line already has, filled with its pack", () => {
    const { pricing } = renderPanel("12 ea eggs", { priceList: [eggs] })
    expect(pricing.lines[0].ingredientId).toBe("eggs")
    openCostCell("eggs")

    expect(screen.getByLabelText("Cost (USD)")).toBeTruthy()
    expect(screen.getByLabelText("Cost (USD)")).toHaveProperty("value", "4.00")
    // The amount reads back on its own; its unit is the dropdown beside it.
    expect(screen.getByLabelText("Size")).toHaveProperty("value", "12")
    expect(screen.getByLabelText("Size unit").textContent).toContain("ea")
    expect(screen.queryByLabelText("Search pricing choices")).toBeNull()
  })

  it("prices a costed line's own match rather than searching", () => {
    renderPanel("225 g butter", { priceList: [butter] })
    openCostCell("butter")

    expect(screen.getByLabelText("Cost (USD)")).toBeTruthy()
    expect(screen.queryByLabelText("Search pricing choices")).toBeNull()
  })

  it("searches for a line matched to nothing", () => {
    const { pricing } = renderPanel("100 g cocoa powder", {
      priceList: [butter],
    })
    expect(pricing.lines[0].ingredientId).toBeNull()
    expect(within(rowFor("cocoa powder")).getByText("Add price")).toBeTruthy()
    openCostCell("cocoa powder")

    expect(screen.getByLabelText("Search pricing choices")).toBeTruthy()
  })
})

/** The same breakdown the Cost tab builds, at $20/h. */
function labor(
  input: {
    prepTimeSeconds?: number | null
    autoPrepTime?: boolean
    steps?: { kind: "active" | "passive"; seconds: number[] }[]
  } = {}
): CostBreakdown {
  return computeCostBreakdown(
    {
      ingredientCostCents: 0,
      batchYield: 1,
      sellableYield: null,
      prepTimeSeconds: input.prepTimeSeconds ?? null,
      autoPrepTime: input.autoPrepTime ?? false,
      steps: (input.steps ?? []).map((step, index) => ({
        id: String(index),
        kind: step.kind,
        timings: step.seconds.map((seconds) => ({ seconds, yieldCount: 1 })),
      })),
    },
    2000
  )
}

describe("RecipeCostingPanel labor", () => {
  it("costs the prep time the cook typed, and says the rate", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({ prepTimeSeconds: 7200 }),
    })
    const row = rowFor("Labor / batch")

    expect(within(row).getByText("$40.00")).toBeTruthy()
    expect(within(row).getByText("2 h at $20/h")).toBeTruthy()
  })

  it("counts the steps the time came from", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({
        autoPrepTime: true,
        steps: [
          { kind: "active", seconds: [600] },
          { kind: "active", seconds: [2100] },
        ],
      }),
    })
    const row = rowFor("Labor / batch")

    expect(within(row).getByText("$15.00")).toBeTruthy()
    expect(within(row).getByText("45 min from 2 timed steps")).toBeTruthy()
  })

  it("names one timed step in the singular", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({
        autoPrepTime: true,
        steps: [{ kind: "active", seconds: [1800] }],
      }),
    })

    expect(
      within(rowFor("Labor / batch")).getByText("30 min from 1 timed step")
    ).toBeTruthy()
  })

  it("says which figure is missing", () => {
    renderPanel("225 g butter", { priceList: [butter], labor: labor() })
    expect(
      within(rowFor("Labor / batch")).getByText("No prep time")
    ).toBeTruthy()
    cleanup()

    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({ autoPrepTime: true }),
    })
    expect(
      within(rowFor("Labor / batch")).getByText("No timed steps")
    ).toBeTruthy()
  })

  it("adds the labor into the batch and the yield unit", () => {
    renderPanel("49.5 g butter", {
      priceList: [butter],
      yieldAmount: 2,
      labor: labor({ prepTimeSeconds: 3600 }),
    })

    expect(cents(rowFor("Cost / batch").textContent ?? "")).toBe(248 + 2000)
    expect(cents(rowFor("Cost per unit").textContent ?? "")).toBe(
      Math.round((248 + 2000) / 2)
    )
  })

  it("warns about untimed steps only where the steps say the time", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({
        autoPrepTime: true,
        steps: [
          { kind: "active", seconds: [600] },
          { kind: "active", seconds: [] },
        ],
      }),
    })
    expect(screen.getByText(/so this cost is partial/)).toBeTruthy()
    cleanup()

    renderPanel("225 g butter", {
      priceList: [butter],
      labor: labor({
        prepTimeSeconds: 600,
        steps: [{ kind: "active", seconds: [] }],
      }),
    })
    expect(screen.queryByText(/so this cost is partial/)).toBeNull()
  })
})

describe("a line left out of cost", () => {
  it("says so instead of pricing it, and flags nothing", () => {
    renderPanel("49.5 g butter\n49.5 g butter", {
      priceList: [butter],
      leftOut: [1],
    })

    const row = screen.getAllByRole("row").at(2)!
    expect(within(row).getByText("Left out")).toBeTruthy()
    expect(within(row).queryByText("Add price")).toBeNull()
    expect(within(row).queryByLabelText("No price yet")).toBeNull()
    // The quantity is still what the cook wrote.
    expect(within(row).getByText("49.5 g")).toBeTruthy()
  })

  it("counts the left-out lines under the batch total", () => {
    renderPanel("49.5 g butter\n49.5 g butter", {
      priceList: [butter],
      leftOut: [1],
    })

    const total = within(rowFor("Ingredient cost / batch"))
    expect(total.getByText("$2.48")).toBeTruthy()
    expect(total.getByText("1 line left out")).toBeTruthy()
  })

  it("names both when two lines sit out", () => {
    renderPanel("49.5 g butter\n49.5 g butter", {
      priceList: [butter],
      leftOut: [0, 1],
    })

    expect(
      within(rowFor("Ingredient cost / batch")).getByText("2 lines left out")
    ).toBeTruthy()
  })

  it("keeps costs on their own rows under an unmeasured first line", () => {
    renderPanel("225 g butter", {
      priceList: [butter],
      extraLines: [forBrushing],
    })

    // The oil row prices nothing; the butter row keeps its own cost.
    expect(within(rowFor("butter")).getByText("$11.25")).toBeTruthy()
    expect(within(rowFor("olive oil")).getByText("Add price")).toBeTruthy()
  })
})
