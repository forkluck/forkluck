// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  MenuMatrix,
  matrixAxis,
  menuMatrixPoints,
} from "@/components/menus/menu-matrix"
import type { MenuItemRow } from "@/lib/backend/types"

afterEach(cleanup)

function item(
  name: string,
  sellPriceCents: number,
  qtySold: number,
  foodCostCents: number | null,
  extra: Partial<MenuItemRow> = {}
): MenuItemRow {
  return {
    id: `item-${name}`,
    name,
    position: 0,
    sellPriceCents,
    qtySold,
    recipeId: "recipe-1",
    recipePublicId: "rcp_1",
    recipeName: name,
    productId: null,
    productPublicId: null,
    productName: null,
    category: null,
    foodCostCents,
    sourceSellPriceCents: sellPriceCents,
    sourceQtySold: null,
    original: { sellPriceCents, qtySold, foodCostCents },
    ...extra,
  }
}

// One of each quadrant against a fifth, uncosted row: average margin is
// $5.64 and the popularity threshold is 39.2 units.
const ITEMS: MenuItemRow[] = [
  item("Burger", 1200, 100, 300),
  item("Fries", 1000, 120, 700),
  item("Steak", 1500, 10, 400),
  item("Soup", 800, 20, 600),
  item("Special", 900, 30, null),
]

/** The legend chip. */
function legendCount(label: string) {
  return screen.getAllByText(label)[0].parentElement?.textContent
}

describe("matrixAxis", () => {
  it("puts the threshold at the middle and half the plot each side", () => {
    const at = matrixAxis(10, 0, 50)
    expect(at(10)).toBeCloseTo(0.5)
    // The one far outlier keeps its own half instead of squashing the rest.
    expect(at(2)).toBeLessThan(0.5)
    expect(at(2)).toBeGreaterThan(0.06)
    expect(at(11)).toBeGreaterThan(0.5)
    expect(at(50)).toBeCloseTo(0.94)
  })
})

describe("menuMatrixPoints", () => {
  it("classifies each row the way the worksheet does", () => {
    const { points, averageMarginDollars, popularityThreshold, uncosted } =
      menuMatrixPoints(ITEMS)

    expect(
      points.map((point) => [point.name, point.class, point.marginCents])
    ).toEqual([
      ["Burger", "star", 900],
      ["Fries", "plowhorse", 300],
      ["Steak", "puzzle", 1100],
      ["Soup", "dog", 200],
    ])
    expect(points[0].grossProfitCents).toBe(90000)
    expect(averageMarginDollars).toBe(5.64)
    expect(popularityThreshold).toBeCloseTo(39.2)
    expect(uncosted.map((item) => item.name)).toEqual(["Special"])

    // The quadrant a dot lands in is the side of centre it is plotted on.
    const side = (name: string) => {
      const point = points.find((candidate) => candidate.name === name)!
      return [point.x > 0.5, point.y > 0.5]
    }
    expect(side("Burger")).toEqual([true, true])
    expect(side("Fries")).toEqual([false, true])
    expect(side("Steak")).toEqual([true, false])
    expect(side("Soup")).toEqual([false, false])
  })

  it("takes a product row's quantity from sales, as the worksheet does", () => {
    const { points } = menuMatrixPoints([
      item("Cookie", 500, 3, 100, {
        productId: "product-1",
        sourceQtySold: 42,
      }),
    ])
    expect(points[0].qtySold).toBe(42)
  })
})

describe("MenuMatrix", () => {
  it("names each class with its count, the period, and the quadrants", () => {
    const { container } = render(
      <MenuMatrix
        items={ITEMS}
        currencyCode="USD"
        periodStart="2026-08-04"
        periodEnd="2026-09-03"
      />
    )

    expect(legendCount("Stars")).toBe("Stars1")
    expect(legendCount("Plowhorses")).toBe("Plowhorses1")
    expect(legendCount("Puzzles")).toBe("Puzzles1")
    expect(legendCount("Dogs")).toBe("Dogs1")
    expect(screen.getByText("Aug 4 – Sep 3, 2026")).toBeTruthy()

    // The legend and the quadrant caption; the table says "Star".
    for (const label of ["Stars", "Plowhorses", "Puzzles", "Dogs"]) {
      expect(screen.getAllByText(label).length).toBe(2)
    }
    expect(screen.getByText("Popularity threshold 39.2 units")).toBeTruthy()
    expect(screen.getByText("Margin per item · avg $5.64")).toBeTruthy()

    // One dot per classified row, coloured by its class, in worksheet order.
    expect(
      Array.from(container.querySelectorAll(".recharts-symbols")).map((dot) =>
        dot.getAttribute("fill")
      )
    ).toEqual([
      "var(--color-success)",
      "var(--color-brand)",
      "var(--color-warning)",
      "var(--color-destructive)",
    ])
  })

  it("lists every item under the chart, stars first, uncosted last", () => {
    render(<MenuMatrix items={ITEMS} currencyCode="USD" />)

    expect(screen.getByText("All time")).toBeTruthy()
    const rows = screen.getAllByRole("row").slice(1) // after the header
    expect(
      rows.map((row) =>
        Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent)
      )
    ).toEqual([
      ["Burger", "Star", "100", "$9.00", "$900.00"],
      ["Fries", "Plowhorse", "120", "$3.00", "$360.00"],
      ["Steak", "Puzzle", "10", "$11.00", "$110.00"],
      ["Soup", "Dog", "20", "$2.00", "$40.00"],
      ["Special", "No food cost yet", "30", "–", "–"],
    ])
    expect(
      screen.getByRole("link", { name: "Burger" }).getAttribute("href")
    ).toBe("/recipes/rcp_1/recipe")
  })

  it("shows an empty state when nothing can be classified", () => {
    render(
      <MenuMatrix items={[item("Special", 900, 30, null)]} currencyCode="USD" />
    )
    expect(screen.getByText(/Nothing to plot yet/)).toBeTruthy()
    expect(screen.queryByText(/aren't shown/)).toBeNull()
  })
})
