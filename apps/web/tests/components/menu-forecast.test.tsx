// @vitest-environment jsdom

import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MenuForecast } from "@/components/menus/menu-forecast"
import type { MenuForecast as MenuForecastData } from "@/lib/backend/types"

afterEach(cleanup)

const SERIES: MenuForecastData["series"] = [
  {
    date: "2026-04-25",
    actualCents: 1200,
    typicalCents: null,
    busyCents: null,
  },
  {
    date: "2026-04-26",
    actualCents: 1400,
    typicalCents: 1400,
    busyCents: 1400,
  },
  {
    date: "2026-04-27",
    actualCents: null,
    typicalCents: 1300,
    busyCents: 1900,
  },
]

const FORECAST: MenuForecastData = {
  menu: { id: "menu-1", publicId: "mnu_spring", name: "Spring" },
  basis: {
    timezone: "America/New_York",
    historyStart: "2026-03-02",
    historyEnd: "2026-04-26",
    horizonStart: "2026-04-27",
    horizonEnd: "2026-05-03",
    horizonDays: 7,
    historyWeeks: 8,
    plan: "typical",
    seasonalAdjustment: false,
    compositionBasis: "current",
  },
  coverage: {
    menuItems: 2,
    linkedMenuItems: 1,
    unresolvedMenuItems: 1,
    products: 1,
    productsWithHistory: 1,
    productsWithoutHistory: 0,
    inactiveProducts: 1,
    unresolvedPaths: 2,
  },
  revenue: {
    currencyCode: "USD",
    typicalCents: 9100,
    busyCents: 13300,
    plannedCents: 9100,
    pricedProducts: 1,
    unpricedProducts: 1,
  },
  series: SERIES,
  backtest: {
    weeks: [
      {
        start: "2026-03-30",
        end: "2026-04-05",
        typicalCents: 9000,
        busyCents: 13000,
        actualCents: 9500,
      },
      {
        start: "2026-04-06",
        end: "2026-04-12",
        typicalCents: 9000,
        busyCents: 13000,
        actualCents: 9500,
      },
      {
        start: "2026-04-13",
        end: "2026-04-19",
        typicalCents: 9000,
        busyCents: 13000,
        actualCents: 9500,
      },
      {
        start: "2026-04-20",
        end: "2026-04-26",
        typicalCents: 9000,
        busyCents: 13000,
        actualCents: 9500,
      },
    ],
    scoredWeeks: 4,
    errorPercent: 12.4,
    busyCoveredWeeks: 3,
  },
  products: [
    {
      productId: "product-1",
      productPublicId: "prd_cookie",
      productName: "Cookie add-on",
      isActive: false,
      menuMember: false,
      weeksObserved: 2,
      typicalQuantity: 7,
      busyQuantity: 11,
      totalQuantity: 7,
    },
    {
      productId: "product-2",
      productPublicId: "prd_scone",
      productName: "Scone",
      isActive: true,
      menuMember: true,
      weeksObserved: 0,
      typicalQuantity: 0,
      busyQuantity: 0,
      totalQuantity: 0,
    },
  ],
  recipeRequirements: [
    {
      recipeId: "recipe-1",
      recipePublicId: "rcp_dough",
      recipeTitle: "Cookie dough",
      batches: 2,
    },
  ],
  materialRequirements: [
    {
      ingredientId: "ingredient-1",
      ingredientPublicId: "ing_wrapper",
      ingredientName: "Wrapper",
      kind: "supply",
      usage: [{ quantity: 7, unit: "each" }],
      purchase: [],
    },
  ],
  unresolved: [
    {
      code: "unlinked-menu-item",
      menuItemId: "item-2",
      menuItemName: "Unlinked special",
    },
    {
      code: "missing-purchase-unit",
      path: ["product-1", "ingredient-1"],
    },
  ],
}

const busy = (): MenuForecastData => ({
  ...FORECAST,
  basis: { ...FORECAST.basis, plan: "busy" },
  revenue: { ...FORECAST.revenue, plannedCents: 13300 },
})

describe("Menu forecast", () => {
  it("renders the independent-menu warning and current-composition basis", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Current composition")).toBeDefined()
    expect(screen.queryByText("Seasonal")).toBeNull()
    expect(
      screen.getByText(/Summing forecasts from multiple Menus can double-count/)
    ).toBeDefined()
    expect(screen.getByText(/1 Menu row is not linked/)).toBeDefined()
  })

  it("shows modifier, inactive, recipe, supply, and unresolved states", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Cookie add-on")).toBeDefined()
    expect(screen.getByText("Modifier")).toBeDefined()
    expect(screen.getByText("Inactive")).toBeDefined()
    expect(screen.getByText("Cookie dough")).toBeDefined()
    expect(screen.getByText("Wrapper")).toBeDefined()
    expect(screen.getByText("Supply")).toBeDefined()
    expect(screen.getByText("missing-purchase-unit")).toBeDefined()
  })

  it("reports both plans and how much history stands behind them", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByRole("columnheader", { name: "Typical" })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: "Busy" })).toBeDefined()
    expect(screen.getByText("2 of 8 weeks")).toBeDefined()
    expect(screen.getByText("No sales in the last 8 weeks")).toBeDefined()
  })

  it("prints product demand in whole units", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          products: [
            {
              ...FORECAST.products[0],
              typicalQuantity: 12.965,
              busyQuantity: 17.521,
              totalQuantity: 12.965,
            },
            {
              ...FORECAST.products[1],
              weeksObserved: 1,
              typicalQuantity: 0.4,
              busyQuantity: 2.5,
              totalQuantity: 0.4,
            },
          ],
        }}
      />
    )

    expect(screen.getByText("13")).toBeDefined()
    expect(screen.getByText("18")).toBeDefined()
    expect(screen.queryByText("12.965")).toBeNull()
    // Some demand is not none: the row that sells one week in eight keeps a
    // figure, and a half rounds up to the unit the kitchen would make.
    expect(screen.getByText("<1")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
  })

  it("prints materials in three digits and steps a thousand grams up to kilograms", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          recipeRequirements: [
            { ...FORECAST.recipeRequirements[0], batches: 2.346 },
          ],
          materialRequirements: [
            {
              ...FORECAST.materialRequirements[0],
              usage: [{ quantity: 980.615, unit: "g" }],
              purchase: [{ quantity: 1234.5, unit: "g" }],
            },
            {
              ingredientId: "ingredient-2",
              ingredientPublicId: "ing_milk",
              ingredientName: "Milk",
              kind: "ingredient",
              usage: [{ quantity: 1500, unit: "ml" }],
              purchase: [{ quantity: 2.5, unit: "each" }],
            },
          ],
        }}
      />
    )

    expect(screen.getByText("2.35")).toBeDefined()
    expect(screen.getByText("981 g")).toBeDefined()
    expect(screen.getByText("1.23 kg")).toBeDefined()
    expect(screen.getByText("1.5 L")).toBeDefined()
    expect(screen.getByText("2.5 ea")).toBeDefined()
  })

  it("restates weights in a US kitchen's ounces and pounds", () => {
    render(
      <MenuForecast
        measurementSystem="us"
        forecast={{
          ...FORECAST,
          materialRequirements: [
            {
              ...FORECAST.materialRequirements[0],
              usage: [{ quantity: 300, unit: "g" }],
              purchase: [{ quantity: 1234.5, unit: "g" }],
            },
          ],
        }}
      />
    )

    expect(screen.getByText("10.6 oz")).toBeDefined()
    expect(screen.getByText("2.72 lb")).toBeDefined()
  })

  it("heros the planned revenue with its accuracy and unpriced notes", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Projected sales")).toBeDefined()
    expect(screen.getByText("$91")).toBeDefined()
    expect(
      screen.getByText("1 product has no price and is left out of the total.")
    ).toBeDefined()
    expect(
      screen.getByText(
        /within 12% of actual sales; busy covered 3 of 4 weeks with sales/
      )
    ).toBeDefined()
    expect(
      screen.getByText(
        /\$26 of actual sales over the last 2 days, then 1 projected days: \$91 typical, up to \$133 busy\./
      )
    ).toBeDefined()
    expect(screen.getAllByText("Typical plan").length).toBe(2)
  })

  it("plans for busy without moving the busy column", () => {
    render(<MenuForecast measurementSystem="metric" forecast={busy()} />)

    expect(screen.getByText("$133")).toBeDefined()
    expect(screen.getAllByText("Busy plan").length).toBe(2)
  })

  it("replaces the chart when nothing on the Menu is priced", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          revenue: { ...FORECAST.revenue, pricedProducts: 0 },
        }}
      />
    )

    expect(screen.getByText(/nothing to project in money/)).toBeDefined()
  })

  it("marks the active pills and keeps the other parameter in each link", () => {
    render(<MenuForecast measurementSystem="metric" forecast={busy()} />)

    const week = screen.getByText("Next 7 days")
    const month = screen.getByText("Next 30 days")
    expect(week.getAttribute("aria-current")).toBe("page")
    // Only the active pill is current; the inactive one carries nothing for a
    // screen reader to announce as the place it already is.
    expect(month.getAttribute("aria-current")).toBeNull()
    expect(
      screen.getByRole("link", { name: "Busy" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      screen.getByRole("link", { name: "Typical" }).getAttribute("aria-current")
    ).toBeNull()
    expect(week.getAttribute("href")).toBe(
      "/menu/mnu_spring/forecast?plan=busy"
    )
    expect(month.getAttribute("href")).toBe(
      "/menu/mnu_spring/forecast?days=30&plan=busy"
    )
    expect(
      screen.getByRole("link", { name: "Typical" }).getAttribute("href")
    ).toBe("/menu/mnu_spring/forecast")
  })

  it("leaves the 30-day and busy pills uncurrent on a 7-day typical forecast", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Next 7 days").getAttribute("aria-current")).toBe(
      "page"
    )
    expect(
      screen.getByText("Next 30 days").getAttribute("aria-current")
    ).toBeNull()
    expect(
      screen.getByRole("link", { name: "Typical" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      screen.getByRole("link", { name: "Busy" }).getAttribute("aria-current")
    ).toBeNull()
  })
})
