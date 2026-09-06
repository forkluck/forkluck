import { describe, expect, it } from "vitest"

import {
  MENU_CLASS_LABELS,
  deriveRows,
  originalFigures,
  summarize,
  type MenuFigures,
} from "@/lib/menu/engineering"

describe("deriveRows", () => {
  it("derives one row's revenue, margin and percentages", () => {
    const { rows, summary } = deriveRows([
      { sellPriceCents: 1000, qtySold: 20, foodCostCents: 300 },
    ])

    expect(rows[0].revenueCents).toBe(20000)
    expect(rows[0].marginCents).toBe(700)
    expect(rows[0].grossProfitCents).toBe(14000)
    expect(rows[0].foodCostPercent).toBeCloseTo(0.3)
    expect(rows[0].percentOfSales).toBe(1)
    expect(rows[0].menuMix).toBe(1)
    expect(summary).toMatchObject({
      revenueCents: 20000,
      costCents: 6000,
      profitCents: 14000,
      quantity: 20,
      uncostedCount: 0,
      averageMarginCents: 700,
    })
    expect(summary.menuCostPercent).toBeCloseTo(0.3)
  })

  it("has no food-cost percent at a zero sell price", () => {
    const { rows } = deriveRows([
      { sellPriceCents: 0, qtySold: 5, foodCostCents: 300 },
    ])
    expect(rows[0].foodCostPercent).toBeNull()
    expect(rows[0].marginCents).toBe(-300)
  })

  it("counts an uncosted row's revenue but not its cost", () => {
    const { rows, summary } = deriveRows([
      { sellPriceCents: 1000, qtySold: 2, foodCostCents: null },
    ])
    expect(summary.revenueCents).toBe(2000)
    expect(summary.costCents).toBe(0)
    expect(summary.uncostedCount).toBe(1)
    expect(rows[0].marginCents).toBeNull()
    expect(rows[0].grossProfitCents).toBeNull()
    expect(rows[0].foodCostPercent).toBeNull()
    expect(rows[0].class).toBeNull()
  })

  it("has no percentages at all when nothing sold", () => {
    const { rows, summary } = deriveRows([
      { sellPriceCents: 0, qtySold: 0, foodCostCents: 300 },
    ])
    expect(summary.menuCostPercent).toBeNull()
    expect(rows[0].percentOfSales).toBeNull()
    expect(rows[0].menuMix).toBeNull()
    expect(rows[0].class).toBeNull()
  })

  it("classifies the empty worksheet as nothing", () => {
    const { rows, summary } = deriveRows([])
    expect(rows).toEqual([])
    expect(summary.menuCostPercent).toBeNull()
    expect(summary.averageMarginCents).toBe(0)
  })

  it("sorts a menu into the four quadrants", () => {
    const { rows, summary } = deriveRows([
      { sellPriceCents: 1000, qtySold: 100, foodCostCents: 200 },
      { sellPriceCents: 500, qtySold: 120, foodCostCents: 300 },
      { sellPriceCents: 2000, qtySold: 10, foodCostCents: 500 },
      { sellPriceCents: 400, qtySold: 10, foodCostCents: 300 },
    ])

    expect(summary.averageMarginCents).toBe(500)
    expect(rows.map((row) => row.class)).toEqual([
      "star",
      "plowhorse",
      "puzzle",
      "dog",
    ])
    expect(rows.map((row) => MENU_CLASS_LABELS[row.class!])).toEqual([
      "Star",
      "Plowhorse",
      "Puzzle",
      "Dog",
    ])
  })

  it("treats exactly 0.7 / N as popular, and a hair under as not", () => {
    const popular = deriveRows([
      { sellPriceCents: 1000, qtySold: 7, foodCostCents: 400 },
      { sellPriceCents: 1000, qtySold: 13, foodCostCents: 400 },
    ])
    expect(popular.rows[0].menuMix).toBeCloseTo(0.35)
    expect(popular.rows[0].class).toBe("star")

    const under = deriveRows([
      { sellPriceCents: 1000, qtySold: 6.9, foodCostCents: 400 },
      { sellPriceCents: 1000, qtySold: 13.1, foodCostCents: 400 },
    ])
    expect(under.rows[0].class).toBe("puzzle")
  })

  it("never calls a row with no sales popular", () => {
    const { rows } = deriveRows([
      { sellPriceCents: 500, qtySold: 0, foodCostCents: 400 },
      { sellPriceCents: 1000, qtySold: 10, foodCostCents: 400 },
      { sellPriceCents: 900, qtySold: 0, foodCostCents: null },
    ])
    expect(rows[0].class).toBe("dog")
    expect(rows[1].class).toBe("star")
    expect(rows[2].class).toBeNull()
  })
})

describe("originalFigures", () => {
  const current: MenuFigures = {
    sellPriceCents: 1200,
    qtySold: 30,
    foodCostCents: 400,
  }

  it("falls back to the current figures on an unsaved row", () => {
    expect(originalFigures({ ...current, original: null })).toEqual(current)
  })

  it("shows the variance an edit opened up", () => {
    const items = [
      {
        ...current,
        original: { sellPriceCents: 1000, qtySold: 30, foodCostCents: 400 },
      },
    ]
    const now = deriveRows(items).summary
    const before = summarize(items.map(originalFigures))

    expect(now.revenueCents - before.revenueCents).toBe(6000)
    expect(now.profitCents - before.profitCents).toBe(6000)
    expect(before.revenueCents).toBe(30000)
  })
})
