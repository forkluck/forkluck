import { describe, expect, it } from "vitest"

import {
  accuracySentence,
  chartSummary,
  forecastChartPoints,
  materialCostSentence,
} from "@/components/menus/forecast-series"
import type { MenuForecast } from "@/lib/backend/types"

const HORIZON_START = "2026-04-27"

/** 28 history days then 30 horizon days, bridged on the last history day. */
function series(): MenuForecast["series"] {
  const rows: MenuForecast["series"] = []
  const start = Date.UTC(2026, 2, 30)
  for (let index = 0; index < 58; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    const horizon = date >= HORIZON_START
    const bridge = index === 27
    rows.push({
      date,
      actualCents: horizon ? null : 1000 + index,
      typicalCents: horizon ? 900 : bridge ? 1027 : null,
      busyCents: horizon ? 1400 : bridge ? 1027 : null,
    })
  }
  return rows
}

/** `count` replayed weeks; only their number matters to the sentence. */
function week(count: number): MenuForecast["backtest"]["weeks"] {
  return Array.from({ length: count }, (_, index) => ({
    start: `2026-03-${String(2 + index * 7).padStart(2, "0")}`,
    end: `2026-03-${String(8 + index * 7).padStart(2, "0")}`,
    typicalCents: 0,
    busyCents: 0,
    actualCents: 0,
  }))
}

describe("forecastChartPoints", () => {
  it("bands the horizon and the bridge row only, and names today", () => {
    const { points, todayLabel } = forecastChartPoints(series(), HORIZON_START)

    expect(points.filter((point) => point.band).length).toBe(31)
    expect(points[26]!.band).toBeNull()
    expect(points[27]!.band).toEqual([1027, 1027])
    expect(points[27]!.isHorizon).toBe(false)
    expect(points[28]!.band).toEqual([900, 1400])
    expect(todayLabel).toBe("Apr 27")
  })
})

describe("chartSummary", () => {
  it("adds up history but takes the horizon from the pooled revenue", () => {
    const rows = series()
    const summary = chartSummary(
      rows,
      {
        currencyCode: "USD",
        typicalCents: 27_000,
        busyCents: 31_000,
        plannedCents: 27_000,
        pricedProducts: 2,
        unpricedProducts: 0,
      },
      HORIZON_START
    )

    // 28 history days of 1000 + index, and the horizon read off revenue rather
    // than summed from the daily busy values (30 x 1400 would say $420).
    expect(summary).toBe(
      "$284 of actual sales over the last 28 days, then 30 projected days: $270 typical, up to $310 busy."
    )
  })
})

describe("accuracySentence", () => {
  it("says so when there is nothing to score", () => {
    expect(
      accuracySentence({
        weeks: [],
        scoredWeeks: 0,
        errorPercent: null,
        busyCoveredWeeks: 0,
      })
    ).toBe("Not enough sales history to check accuracy yet.")
  })

  it("rounds the error and reports busy coverage", () => {
    expect(
      accuracySentence({
        weeks: week(4),
        scoredWeeks: 4,
        errorPercent: 12.4,
        busyCoveredWeeks: 3,
      })
    ).toBe(
      "Over the last 4 weeks the typical plan landed within 12% of actual sales. The busy plan covered 3 of 4 weeks with sales."
    )
  })

  it("names the whole window even when only some weeks sold anything", () => {
    expect(
      accuracySentence({
        weeks: week(4),
        scoredWeeks: 2,
        errorPercent: 12.4,
        busyCoveredWeeks: 2,
      })
    ).toBe(
      "Over the last 4 weeks the typical plan landed within 12% of actual sales. The busy plan covered 2 of 2 weeks with sales."
    )
  })
})

describe("materialCostSentence", () => {
  const revenue = {
    currencyCode: "USD",
    typicalCents: 9100,
    busyCents: 13300,
    plannedCents: 9100,
    pricedProducts: 1,
    unpricedProducts: 0,
  }

  it("says nothing when the forecast reaches no material", () => {
    expect(
      materialCostSentence({
        revenue,
        materialCost: {
          costCents: 0,
          costedMaterials: 0,
          uncostedMaterials: 0,
        },
      })
    ).toBeNull()
  })

  it("prices the list as a share of the sales it serves", () => {
    expect(
      materialCostSentence({
        revenue,
        materialCost: {
          costCents: 1972,
          costedMaterials: 3,
          uncostedMaterials: 0,
        },
      })
    ).toBe("Projected ingredient cost $20, 22% of projected sales.")
  })

  it("keeps the cost and drops the share when nothing is priced for sale", () => {
    expect(
      materialCostSentence({
        revenue: { ...revenue, pricedProducts: 0, plannedCents: 0 },
        materialCost: {
          costCents: 1972,
          costedMaterials: 3,
          uncostedMaterials: 2,
        },
      })
    ).toBe(
      "Projected ingredient cost $20. 2 materials have no pack size or price."
    )
  })

  it("explains an empty total rather than printing a free shopping list", () => {
    expect(
      materialCostSentence({
        revenue,
        materialCost: {
          costCents: 0,
          costedMaterials: 0,
          uncostedMaterials: 1,
        },
      })
    ).toBe(
      "No material has a pack size and a price yet, so there is no projected ingredient cost. 1 material has no pack size or price."
    )
  })
})
