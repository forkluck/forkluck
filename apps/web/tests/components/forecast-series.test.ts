import { describe, expect, it } from "vitest"

import {
  accuracySentence,
  chartSummary,
  forecastChartPoints,
  moneyCaption,
} from "@/components/menus/forecast-series"
import type { MenuForecast } from "@/lib/backend/types"

const HORIZON_START = "2026-04-27"
function series(): MenuForecast["series"] {
  return Array.from({ length: 58 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 2, 30 + index))
      .toISOString()
      .slice(0, 10)
    const horizon = date >= HORIZON_START
    const bridge = index === 27
    return {
      date,
      actualUnits: horizon ? null : 1000 + index,
      typicalUnits: horizon ? 900 : bridge ? 1027 : null,
      plannedUnits: horizon ? 1400 : bridge ? 1027 : null,
    }
  })
}
function weeks(count: number): MenuForecast["backtest"]["weeks"] {
  return Array.from({ length: count }, (_, index) => ({
    start: `2026-03-${2 + index * 7}`,
    end: `2026-03-${8 + index * 7}`,
    typicalUnits: 0,
    busyUnits: 0,
    actualUnits: 0,
  }))
}

describe("forecastChartPoints", () => {
  it("shows the chosen-plan band only on the busy plan and preserves the bridge", () => {
    const { points, todayLabel } = forecastChartPoints(
      series(),
      HORIZON_START,
      "busy"
    )
    expect(points.filter((point) => point.band)).toHaveLength(31)
    expect(points[26]!.band).toBeNull()
    expect(points[27]!.band).toEqual([1027, 1027])
    expect(points[27]!.isHorizon).toBe(false)
    expect(points[28]!.band).toEqual([900, 1400])
    expect(todayLabel).toBe("Apr 27")
    expect(
      forecastChartPoints(series(), HORIZON_START, "typical").points.every(
        (point) => point.band === null
      )
    ).toBe(true)
  })
})

describe("chartSummary", () => {
  it("names menu history separately from the full production plan", () => {
    expect(
      chartSummary(
        series(),
        {
          typicalUnits: 27000,
          busyUnits: 31000,
          plannedUnits: 27000,
          recipeBatches: 120,
          productsPlanned: 2,
        },
        HORIZON_START
      )
    ).toBe(
      "Menu items: 28,378 actual units over the last 28 days. Production plan across all product rows for 30 days: 27,000 typical, 31,000 busy, 27,000 planned."
    )
  })
})

describe("accuracySentence", () => {
  it("keeps the unavailable accuracy state", () => {
    expect(
      accuracySentence({
        weeks: [],
        scoredWeeks: 0,
        errorPercent: null,
        busyCoveredWeeks: 0,
      })
    ).toBe("Not enough sales history to check accuracy yet.")
  })
  it("names the measured error in units without promising each week is within it", () => {
    expect(
      accuracySentence({
        weeks: weeks(4),
        scoredWeeks: 2,
        errorPercent: 12.4,
        busyCoveredWeeks: 2,
      })
    ).toBe(
      "Over the last 4 weeks the typical plan’s volume-weighted error was 12% of actual units. The busy plan covered 2 of 2 weeks with sales."
    )
  })
})

describe("moneyCaption", () => {
  const revenue = {
    currencyCode: "USD",
    typicalCents: 9100,
    busyCents: 13300,
    plannedCents: 9100,
    pricedProducts: 1,
    unpricedProducts: 0,
  }
  it("keeps one sales caption when there are no materials", () => {
    expect(
      moneyCaption({
        revenue,
        materialCost: {
          costCents: 0,
          costedMaterials: 0,
          uncostedMaterials: 0,
        },
      })
    ).toBe("Projected sales at current menu prices: $91.")
  })
  it("adds ingredient cost and its share to the same caption", () => {
    expect(
      moneyCaption({
        revenue,
        materialCost: {
          costCents: 1972,
          costedMaterials: 3,
          uncostedMaterials: 0,
        },
      })
    ).toBe(
      "Projected sales at current menu prices: $91 · Ingredient cost: $20 (22% of projected sales)."
    )
  })
  it("reports missing prices and omits a share without priced sales", () => {
    expect(
      moneyCaption({
        revenue: { ...revenue, pricedProducts: 0, plannedCents: 0 },
        materialCost: {
          costCents: 1972,
          costedMaterials: 3,
          uncostedMaterials: 2,
        },
      })
    ).toBe(
      "No menu prices yet · Ingredient cost: $20; 2 materials need a pack size or price."
    )
  })
  it("does not mistake an uncosted list for free ingredients", () => {
    expect(
      moneyCaption({
        revenue,
        materialCost: {
          costCents: 0,
          costedMaterials: 0,
          uncostedMaterials: 1,
        },
      })
    ).toBe(
      "Projected sales at current menu prices: $91 · Ingredient cost unavailable; 1 material needs a pack size or price."
    )
  })
  it("labels incomplete sales when giving a cost share", () => {
    expect(
      moneyCaption({
        revenue: { ...revenue, unpricedProducts: 2 },
        materialCost: {
          costCents: 1972,
          costedMaterials: 3,
          uncostedMaterials: 0,
        },
      })
    ).toContain(
      "$91 (2 products unpriced) · Ingredient cost: $20 (22% of priced projected sales)"
    )
  })
})
