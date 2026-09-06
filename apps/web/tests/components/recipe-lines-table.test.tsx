// @vitest-environment jsdom

import type * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ingredients/price-line-dialog", () => ({
  PriceLineDialog: ({
    trigger,
    open,
  }: {
    trigger?: React.ReactElement
    open?: boolean
  }) => (
    <>
      {open ? <div data-testid="picker-open" /> : null}
      {trigger ?? null}
    </>
  ),
}))

import { RecipeLinesTable } from "@/components/recipes/recipe-lines-table"
import type { PriceListEntry, PricedLine } from "@/lib/pricing"
import { parseRecipeText, type IngredientMeasure } from "@/lib/recipe"

afterEach(cleanup)

const pantryEntry: PriceListEntry = {
  id: "pantry-sauce",
  name: "Mystery sauce",
  normalizedName: "mystery sauce",
  purchaseCostCents: 500,
  purchaseSize: 1_000,
  purchaseUnit: "g",
  source: "pantry",
}

function pricedLine(ingredientId: string | null): PricedLine {
  return {
    name: "Mystery sauce",
    grams: null,
    ingredientId,
    costCents: null,
    basis: null,
    needsConversion: true,
    needsReview: false,
  }
}

describe("recipe line measurement workflow", () => {
  it("shows a piece-yield component as a costed count, not a missing weight", () => {
    const component: PriceListEntry = {
      id: "component-jam",
      name: "Cookie jam",
      normalizedName: "cookie jam",
      purchaseCostCents: 800,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "component",
      componentYieldAmount: 60,
      componentYieldUnit: "pcs",
    }
    const line = parseRecipeText("1 ea Cookie jam", {
      identities: [component],
    }).parsedLines[0]

    render(
      <RecipeLinesTable
        lines={[line]}
        priced={[
          {
            name: "Cookie jam",
            grams: null,
            componentQuantity: { amount: 1, unit: "each" },
            ingredientId: component.id,
            costCents: 800 / 60,
            basis: null,
            needsConversion: false,
            needsReview: false,
          },
        ]}
        priceList={[component]}
        skipped={[]}
        onAddLine={vi.fn(() => true)}
        onDeleteLine={vi.fn()}
        onEditLine={vi.fn()}
        onSetWeight={vi.fn()}
        onLinked={vi.fn()}
      />
    )

    // The count and its unit are separate columns now.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("ea")).toBeDefined()
    expect(screen.queryByRole("button", { name: "Set weight" })).toBeNull()
  })

  it("sorts counted components by their displayed piece count in both directions", () => {
    const cookieJam: PriceListEntry = {
      id: "component-cookie-jam",
      name: "Cookie jam",
      normalizedName: "cookie jam",
      purchaseCostCents: 800,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "component",
      componentYieldAmount: 60,
      componentYieldUnit: "pcs",
    }
    const berryJam: PriceListEntry = {
      id: "component-berry-jam",
      name: "Berry jam",
      normalizedName: "berry jam",
      purchaseCostCents: 400,
      purchaseSize: 1000,
      purchaseUnit: "g",
      source: "component",
      componentYieldAmount: 40,
      componentYieldUnit: "pcs",
    }
    // Written order puts the larger count first, so a working sort must move it.
    const parsed = parseRecipeText("5 ea Cookie jam\n1 ea Berry jam", {
      identities: [cookieJam, berryJam],
    })
    const lines = parsed.parsedLines
    expect(lines).toHaveLength(2)
    expect(lines[0].componentQuantity?.amount).toBe(5)
    expect(lines[1].componentQuantity?.amount).toBe(1)

    const priced: PricedLine[] = [
      {
        name: "Cookie jam",
        grams: null,
        componentQuantity: { amount: 5, unit: "each" },
        ingredientId: cookieJam.id,
        costCents: (800 / 60) * 5,
        basis: null,
        needsConversion: false,
        needsReview: false,
      },
      {
        name: "Berry jam",
        grams: null,
        componentQuantity: { amount: 1, unit: "each" },
        ingredientId: berryJam.id,
        costCents: 400 / 40,
        basis: null,
        needsConversion: false,
        needsReview: false,
      },
    ]

    render(
      <RecipeLinesTable
        lines={lines}
        priced={priced}
        priceList={[cookieJam, berryJam]}
        skipped={[]}
        onAddLine={vi.fn(() => true)}
        onDeleteLine={vi.fn()}
        onEditLine={vi.fn()}
        onSetWeight={vi.fn()}
        onLinked={vi.fn()}
      />
    )

    const componentOrder = () =>
      screen
        .getAllByRole("row")
        .map((row) =>
          (row.querySelectorAll("td")[0]?.textContent ?? "").replace(
            /Component$/,
            ""
          )
        )
        .filter((text) => text === "Cookie jam" || text === "Berry jam")

    // Default is written order: 5 ea then 1 ea.
    expect(componentOrder()).toEqual(["Cookie jam", "Berry jam"])

    const amountSort = screen.getByRole("button", { name: /Qty/ })

    // Ascending: 1 ea (Berry jam) before 5 ea (Cookie jam).
    fireEvent.click(amountSort)
    expect(componentOrder()).toEqual(["Berry jam", "Cookie jam"])

    // Descending: 5 ea (Cookie jam) before 1 ea (Berry jam).
    fireEvent.click(amountSort)
    expect(componentOrder()).toEqual(["Cookie jam", "Berry jam"])
  })

  it("asks what an unrecognised line is before what it weighs", () => {
    const line = parseRecipeText("1 cup Mystery sauce").unresolvedLines[0]
    const props = {
      lines: [line],
      priceList: [pantryEntry],
      skipped: [],
      onAddLine: vi.fn(() => true),
      onDeleteLine: vi.fn(),
      onEditLine: vi.fn(),
      onSetWeight: vi.fn(),
      onLinked: vi.fn(),
    }
    render(<RecipeLinesTable {...props} priced={[pricedLine(null)]} />)

    // An unrecognised name is the first question, ahead of any weight.
    expect(
      screen.getByRole("button", { name: "Not in your ingredients" })
    ).toBeDefined()
    // Every action lives in the alert; cost itself moved to the Costing tab.
    expect(screen.queryByRole("button", { name: "Set weight" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Match ingredient" })
    ).toBeNull()
  })

  it("labels a disputed catalog range for review", () => {
    const catalogMeasure: IngredientMeasure = {
      id: "catalog-sauce-cup",
      ingredientId: null,
      name: "Mystery sauce",
      normalizedName: "mystery sauce",
      unit: "cup",
      amount: 1,
      grams: 125,
      lowGrams: 100,
      highGrams: 150,
      qualifier: "",
      source: "catalog",
      confidence: "medium",
    }
    const line = parseRecipeText("1 cup Mystery sauce", {
      measures: [catalogMeasure],
    }).parsedLines[0]

    render(
      <RecipeLinesTable
        lines={[line]}
        priced={[
          {
            name: "Mystery sauce",
            grams: 125,
            ingredientId: pantryEntry.id,
            costCents: 62.5,
            basis: null,
            needsConversion: false,
            needsReview: true,
          },
        ]}
        priceList={[pantryEntry]}
        skipped={[]}
        onAddLine={vi.fn(() => true)}
        onDeleteLine={vi.fn()}
        onEditLine={vi.fn()}
        onSetWeight={vi.fn()}
        onLinked={vi.fn()}
      />
    )

    expect(screen.getByText("review").getAttribute("title")).toContain(
      "possible range"
    )
  })

  it("opens the reusable weight workflow for a catalog-resolved line", () => {
    const catalogMeasure: IngredientMeasure = {
      id: "catalog-sauce-cup",
      ingredientId: null,
      name: "Mystery sauce",
      normalizedName: "mystery sauce",
      unit: "cup",
      amount: 1,
      grams: 125,
      lowGrams: null,
      highGrams: null,
      qualifier: "",
      source: "catalog",
      confidence: "high",
    }
    const line = parseRecipeText("1 cup Mystery sauce", {
      measures: [catalogMeasure],
    }).parsedLines[0]
    const onEditLine = vi.fn()
    const onSetWeight = vi.fn()

    render(
      <RecipeLinesTable
        lines={[line]}
        priced={[
          {
            name: "Mystery sauce",
            grams: 125,
            ingredientId: pantryEntry.id,
            costCents: 62.5,
            basis: null,
            needsConversion: false,
            needsReview: false,
          },
        ]}
        priceList={[pantryEntry]}
        skipped={[]}
        onAddLine={vi.fn(() => true)}
        onDeleteLine={vi.fn()}
        onEditLine={onEditLine}
        onSetWeight={onSetWeight}
        onLinked={vi.fn()}
      />
    )

    fireEvent.click(
      screen.getByTitle(
        "Replace this catalog estimate and optionally remember it"
      )
    )
    expect(onSetWeight).toHaveBeenCalledWith(line, pantryEntry.id)
    expect(onEditLine).not.toHaveBeenCalled()
  })
})
