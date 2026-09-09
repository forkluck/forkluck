// @vitest-environment jsdom

import * as React from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MenuForecast } from "@/components/menus/menu-forecast"
import type { MenuForecast as MenuForecastData } from "@/lib/backend/types"

afterEach(cleanup)

const DATES = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2026, 3, 27 + index)).toISOString().slice(0, 10)
)
const RECENT = Array.from({ length: 8 }, (_, index) => ({
  start: new Date(Date.UTC(2026, 2, 2 + index * 7)).toISOString().slice(0, 10),
  end: new Date(Date.UTC(2026, 2, 8 + index * 7)).toISOString().slice(0, 10),
  units: 7,
  lastYearUnits: 6,
}))

const SERIES: MenuForecastData["series"] = [
  {
    date: "2026-04-25",
    actualUnits: 1200,
    typicalUnits: null,
    plannedUnits: null,
  },
  {
    date: "2026-04-26",
    actualUnits: 1400,
    typicalUnits: 1400,
    plannedUnits: 1400,
  },
  {
    date: "2026-04-27",
    actualUnits: null,
    typicalUnits: 1300,
    plannedUnits: 1900,
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
    weeks: {
      recent: RECENT,
      horizon: [
        {
          start: DATES[0]!,
          end: DATES[6]!,
          typicalUnits: 7,
          plannedUnits: 7,
          lastYearUnits: 8,
        },
      ],
    },
    level: { weeklyUnits: 7, seasonalFactor: 1, seasonalProducts: 0 },
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
  materialCost: { costCents: 0, costedMaterials: 0, uncostedMaterials: 1 },
  production: {
    typicalUnits: 7,
    busyUnits: 11,
    plannedUnits: 7,
    recipeBatches: 2,
    productsPlanned: 1,
  },
  days: DATES.map((date) => ({ date, typicalUnits: 1, plannedUnits: 1 })),
  series: SERIES,
  backtest: {
    weeks: [
      {
        start: "2026-03-30",
        end: "2026-04-05",
        typicalUnits: 9000,
        busyUnits: 13000,
        actualUnits: 9500,
      },
      {
        start: "2026-04-06",
        end: "2026-04-12",
        typicalUnits: 9000,
        busyUnits: 13000,
        actualUnits: 9500,
      },
      {
        start: "2026-04-13",
        end: "2026-04-19",
        typicalUnits: 9000,
        busyUnits: 13000,
        actualUnits: 9500,
      },
      {
        start: "2026-04-20",
        end: "2026-04-26",
        typicalUnits: 9000,
        busyUnits: 13000,
        actualUnits: 9500,
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
      seasonalFactor: 1,
      days: DATES.map((date) => ({
        date,
        typicalQuantity: 1,
        plannedQuantity: 1,
      })),
      priceCents: null,
      typicalCents: null,
      busyCents: null,
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
      seasonalFactor: 1,
      days: DATES.map((date) => ({
        date,
        typicalQuantity: 0,
        plannedQuantity: 0,
      })),
      priceCents: null,
      typicalCents: null,
      busyCents: null,
    },
  ],
  recipeRequirements: [
    {
      recipeId: "recipe-1",
      recipePublicId: "rcp_dough",
      recipeTitle: "Cookie dough",
      batches: 2,
      days: DATES.map((date, index) => ({
        date,
        batches: index === 0 ? 2 : 0,
      })),
      yieldAmount: 24,
      yieldUnit: "each",
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
      purchaseSize: null,
      purchaseUnit: null,
      packs: null,
      costCents: null,
      supplierPack: null,
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

/** The tables in page order: Product demand, Recipe batches, materials. */
const table = (index: number) =>
  within(document.querySelectorAll("table")[index] as HTMLElement)
/** One link per row, so the links are the row order. */
const rowsOf = (index: number) =>
  table(index)
    .getAllByRole("link")
    .map((link) => link.textContent)

const busy = (): MenuForecastData => ({
  ...FORECAST,
  basis: { ...FORECAST.basis, plan: "busy" },
  revenue: { ...FORECAST.revenue, plannedCents: 13300 },
  production: { ...FORECAST.production, plannedUnits: 11 },
})

describe("Menu forecast", () => {
  it("renders the independent-menu warning and current-composition basis", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Current composition")).toBeDefined()
    expect(screen.queryByText("Seasonal")).toBeNull()
    expect(screen.getByText("Apr 27 to May 3, 2026")).toBeDefined()
    expect(screen.getByText("How this is calculated")).toBeDefined()
    expect(
      screen.getByText(/Summing forecasts from multiple Menus can double-count/)
    ).toBeDefined()
    expect(screen.getByText(/1 Menu row is not linked/)).toBeDefined()
    expect(screen.getByRole("button", { name: "Actions" })).toBeDefined()
  })

  it("shows modifier, inactive, recipe, supply, and unresolved states", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Cookie add-on")).toBeDefined()
    expect(screen.getByText("Included")).toBeDefined()
    expect(screen.getByText("Inactive")).toBeDefined()
    expect(screen.getByText("Cookie dough")).toBeDefined()
    expect(screen.getByText("Wrapper")).toBeDefined()
    expect(screen.getByText("Supply")).toBeDefined()
    expect(screen.getByText("Set pack size")).toBeDefined()
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

  it("prints materials in three digits, whole counts, and whole packs at the pack price", () => {
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
              purchaseSize: 5,
              purchaseUnit: "kg",
              packs: 0.2469,
              costCents: 1200,
              supplierPack: null,
            },
            {
              ingredientId: "ingredient-2",
              ingredientPublicId: "ing_milk",
              ingredientName: "Milk",
              kind: "ingredient",
              usage: [{ quantity: 1500, unit: "ml" }],
              purchase: [{ quantity: 2.5, unit: "each" }],
              purchaseSize: 12,
              purchaseUnit: "each",
              packs: 0.208,
              costCents: null,
              supplierPack: null,
            },
            {
              ingredientId: "ingredient-3",
              ingredientPublicId: "ing_yolk",
              ingredientName: "Egg yolk",
              kind: "ingredient",
              usage: [
                { quantity: 27, unit: "each" },
                { quantity: 369, unit: "g" },
              ],
              purchase: [{ quantity: 48.7, unit: "each" }],
              purchaseSize: 30,
              purchaseUnit: "each",
              packs: 1.623,
              costCents: 972,
              supplierPack: null,
            },
          ],
        }}
      />
    )

    expect(screen.getByText("2.35")).toBeDefined()
    // A thousand grams steps up to kilograms, and the pack is read the same
    // way. A fifth of a pack is one pack to buy, at the pack's price.
    expect(screen.getByText("1.23 kg")).toBeDefined()
    expect(screen.getByText("5 kg")).toBeDefined()
    expect(screen.getByText("1 × 5 kg")).toBeDefined()
    expect(screen.getByText("1 × 12 ea")).toBeDefined()
    expect(screen.getByText("$12")).toBeDefined()
    // The recipe side is one unit, so it earns no second line.
    expect(screen.queryByText("981 g")).toBeNull()
    expect(screen.queryByText(/from 981 g/)).toBeNull()
    // Nobody buys two and a half eggs; a pack without a price says so.
    expect(screen.getByText("3 ea")).toBeDefined()
    expect(screen.getByText("12 ea")).toBeDefined()
    expect(table(2).getByText("No price")).toBeDefined()
    expect(screen.queryByText("1.5 L")).toBeNull()
    // Two recipes measuring yolk two ways: both shown, under the whole count.
    expect(screen.getByText("49 ea")).toBeDefined()
    expect(screen.getByText("from 27 ea, 369 g")).toBeDefined()
    expect(screen.getByText("2 × 30 ea")).toBeDefined()
    expect(screen.getByText("$10")).toBeDefined()
  })

  it("orders in the supplier's own pack, or by the case when that is the unit", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          materialRequirements: [
            {
              ...FORECAST.materialRequirements[0]!,
              ingredientName: "Flour",
              kind: "ingredient",
              usage: [{ quantity: 17000, unit: "g" }],
              purchase: [{ quantity: 37.5, unit: "lb" }],
              purchaseSize: 24,
              purchaseUnit: "lb",
              packs: 1.5625,
              costCents: 4800,
              supplierPack: {
                supplier: "Baldor",
                rawSize: "24 X 1 LB",
                title: "Flour, all purpose",
              },
            },
            {
              ...FORECAST.materialRequirements[0]!,
              ingredientId: "ingredient-9",
              ingredientPublicId: "ing_avocado",
              ingredientName: "Avocado",
              kind: "ingredient",
              usage: [{ quantity: 55, unit: "each" }],
              purchase: [{ quantity: 2.3, unit: "case" }],
              purchaseSize: 1,
              purchaseUnit: "case",
              packs: 2.3,
              costCents: 9000,
              supplierPack: null,
            },
          ],
        }}
      />
    )

    // The pack in the supplier's words, not the 10.9 kg it converts to.
    expect(screen.getByText("2 × 24 X 1 LB")).toBeDefined()
    expect(screen.getByText("24 X 1 LB")).toBeDefined()
    expect(screen.getByText(/· Baldor/)).toBeDefined()
    expect(screen.queryByText(/10\.9 kg/)).toBeNull()
    // Bought by the case: three cases, and the pack column says so too.
    expect(screen.getByText("3 cases")).toBeDefined()
    expect(screen.getByText("1 case")).toBeDefined()
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
              purchaseSize: 5,
              purchaseUnit: "lb",
              packs: 0.544,
              costCents: 800,
              supplierPack: null,
            },
          ],
        }}
      />
    )

    expect(screen.getByText("2.72 lb")).toBeDefined()
    expect(screen.getByText("5 lb")).toBeDefined()
    expect(screen.getByText("1 × 5 lb")).toBeDefined()
  })

  it("leads with production and keeps money in one caption", () => {
    const { container } = render(
      <MenuForecast measurementSystem="metric" forecast={FORECAST} />
    )
    expect(screen.getByText("To make this week")).toBeDefined()
    expect(container.querySelector(".text-4xl")?.textContent).toBe("7 items")
    expect(screen.getByText("across 1 recipe")).toBeDefined()
    expect(
      screen.getByText(/volume-weighted error was 12% of actual units/)
    ).toBeDefined()
    expect(screen.getByText("Busy plan: 11 items")).toBeDefined()
    expect(screen.getAllByTestId("forecast-money-caption")).toHaveLength(1)
    expect(screen.getByTestId("forecast-money-caption").textContent).toContain(
      "Projected sales at current menu prices: $91 (1 product unpriced)"
    )
    expect(screen.queryByRole("button", { name: "Price" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Projected sales" })).toBeNull()
    expect(screen.getAllByText(/for the typical plan/).length).toBe(2)
  })

  it("plans for busy without moving the busy column", () => {
    const { container } = render(
      <MenuForecast measurementSystem="metric" forecast={busy()} />
    )
    expect(container.querySelector(".text-4xl")?.textContent).toBe("11 items")
    expect(screen.getByText("Typical plan: 7 items")).toBeDefined()
    expect(screen.getAllByText(/for the busy plan/).length).toBe(2)
  })

  it("shows seasonal factors beside product history", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          products: [
            {
              ...FORECAST.products[1]!,
              weeksObserved: 8,
              seasonalFactor: 1.06,
              priceCents: 450,
              typicalCents: 3600,
              busyCents: 5400,
            },
          ],
        }}
      />
    )
    expect(screen.getByText("Full · seasonal 1.06")).toBeDefined()
    expect(table(0).queryByText("$4.50")).toBeNull()
    expect(table(0).queryByText("$36")).toBeNull()
  })

  it("prices the shopping list against the sales it serves", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          materialCost: {
            costCents: 1972,
            costedMaterials: 2,
            uncostedMaterials: 1,
          },
        }}
      />
    )

    expect(
      screen.getByText(
        "Projected sales at current menu prices: $91 (1 product unpriced) · Ingredient cost: $20 (22% of priced projected sales); 1 material needs a pack size or price."
      )
    ).toBeDefined()
  })

  it("says what the batches make, and when a recipe has no yield", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          recipeRequirements: [
            { ...FORECAST.recipeRequirements[0]!, batches: 2.346 },
            {
              recipeId: "recipe-2",
              recipePublicId: "rcp_stock",
              recipeTitle: "Stock",
              batches: 1.5,
              days: DATES.map((date, index) => ({
                date,
                batches: index === 0 ? 1.5 : 0,
              })),
              yieldAmount: 4,
              yieldUnit: "l",
            },
            {
              recipeId: "recipe-3",
              recipePublicId: "rcp_glaze",
              recipeTitle: "Glaze",
              batches: 3,
              days: DATES.map((date, index) => ({
                date,
                batches: index === 0 ? 3 : 0,
              })),
              yieldAmount: null,
              yieldUnit: null,
            },
          ],
        }}
      />
    )

    // 2.35 batches of two dozen is 57 whole cookies; six litres of stock.
    expect(screen.getByText("57 ea")).toBeDefined()
    expect(screen.getByText("24 ea per batch")).toBeDefined()
    expect(screen.getByText("6 L")).toBeDefined()
    expect(screen.getByText("No yield")).toBeDefined()
  })

  it("sorts materials within their kind, ingredients first", () => {
    const material = (
      name: string,
      kind: "ingredient" | "supply",
      packs: number | null,
      costCents: number | null
    ) => ({
      ...FORECAST.materialRequirements[0]!,
      ingredientId: name,
      ingredientPublicId: `ing_${name}`,
      ingredientName: name,
      kind,
      purchase: [{ quantity: 1, unit: "each" }],
      purchaseSize: 1,
      purchaseUnit: "each",
      packs,
      costCents,
      supplierPack: null,
    })
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          materialRequirements: [
            material("Box", "supply", 9, 900),
            material("Sugar", "ingredient", 2, 200),
            material("Flour", "ingredient", 5, 500),
          ],
        }}
      />
    )

    expect(rowsOf(2)).toEqual(["Flour", "Sugar", "Box"])
    fireEvent.click(table(2).getByRole("button", { name: "Cost" }))
    fireEvent.click(table(2).getByRole("button", { name: "Cost" }))
    // Dearest first, and the supply stays at the bottom however dear it is.
    expect(rowsOf(2)).toEqual(["Flour", "Sugar", "Box"])
    fireEvent.click(table(2).getByRole("button", { name: "Cost" }))
    expect(rowsOf(2)).toEqual(["Sugar", "Flour", "Box"])
  })

  it("keeps production and its chart when nothing on the Menu is priced", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          revenue: { ...FORECAST.revenue, pricedProducts: 0 },
        }}
      />
    )

    expect(screen.getByText("Menu items by day")).toBeDefined()
    expect(screen.getByTestId("forecast-money-caption").textContent).toContain(
      "No menu prices yet"
    )
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

  it("sorts product demand by a clicked header and flips it on a second click", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    // The backend's A–Z order stands until a header is chosen.
    expect(rowsOf(0)).toEqual(["Cookie add-on", "Scone"])

    fireEvent.click(table(0).getByRole("button", { name: "Typical" }))
    expect(rowsOf(0)).toEqual(["Scone", "Cookie add-on"])
    fireEvent.click(table(0).getByRole("button", { name: "Typical" }))
    expect(rowsOf(0)).toEqual(["Cookie add-on", "Scone"])

    fireEvent.click(table(0).getByRole("button", { name: "History" }))
    expect(rowsOf(0)).toEqual(["Scone", "Cookie add-on"])

    fireEvent.click(table(0).getByRole("button", { name: "Product" }))
    expect(rowsOf(0)).toEqual(["Cookie add-on", "Scone"])
    fireEvent.click(table(0).getByRole("button", { name: "Product" }))
    expect(rowsOf(0)).toEqual(["Scone", "Cookie add-on"])
  })

  it("keeps tied rows in their incoming order when sorting descending", () => {
    const zero = (name: string, id: string) => ({
      ...FORECAST.products[0]!,
      productId: id,
      productPublicId: `prd_${id}`,
      productName: name,
      typicalQuantity: 0,
      busyQuantity: 0,
      weeksObserved: 0,
    })
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          products: [
            ...FORECAST.products,
            zero("Bun", "bun"),
            zero("Tart", "tart"),
          ],
        }}
      />
    )
    fireEvent.click(table(0).getByRole("button", { name: "Typical" }))
    fireEvent.click(table(0).getByRole("button", { name: "Typical" }))
    // Descending by demand, and the zero-demand tail stays in its incoming
    // order rather than coming out backwards.
    expect(rowsOf(0).slice(-2)).toEqual(["Bun", "Tart"])
    expect(
      table(0)
        .getByRole("columnheader", { name: "Typical" })
        .getAttribute("aria-sort")
    ).toBe("descending")
  })

  it("sorts recipe batches by recipe or by batch count", () => {
    render(
      <MenuForecast
        measurementSystem="metric"
        forecast={{
          ...FORECAST,
          recipeRequirements: [
            ...FORECAST.recipeRequirements,
            {
              recipeId: "recipe-2",
              recipePublicId: "rcp_biscotti",
              recipeTitle: "Almond biscotti",
              batches: 5,
              days: DATES.map((date, index) => ({
                date,
                batches: index === 0 ? 5 : 0,
              })),
              yieldAmount: null,
              yieldUnit: null,
            },
          ],
        }}
      />
    )

    // The backend lists recipes in id order, which means nothing to a cook,
    // so the table opens A to Z.
    expect(rowsOf(1)).toEqual(["Almond biscotti", "Cookie dough"])
    expect(
      table(1)
        .getByRole("columnheader", { name: "Recipe" })
        .getAttribute("aria-sort")
    ).toBe("ascending")

    fireEvent.click(table(1).getByRole("button", { name: "Batches" }))
    expect(rowsOf(1)).toEqual(["Cookie dough", "Almond biscotti"])
    fireEvent.click(table(1).getByRole("button", { name: "Batches" }))
    expect(rowsOf(1)).toEqual(["Almond biscotti", "Cookie dough"])

    fireEvent.click(table(1).getByRole("button", { name: "Recipe" }))
    expect(rowsOf(1)).toEqual(["Almond biscotti", "Cookie dough"])
    fireEvent.click(table(1).getByRole("button", { name: "Recipe" }))
    expect(rowsOf(1)).toEqual(["Cookie dough", "Almond biscotti"])
  })
  it("preserves horizon and plan in day-view links and displays the daily plan", () => {
    render(
      <MenuForecast measurementSystem="metric" forecast={FORECAST} view="day" />
    )
    expect(
      screen.getByRole("link", { name: "Day" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      screen.getByRole("link", { name: "Busy" }).getAttribute("href")
    ).toBe("/menu/mnu_spring/forecast?plan=busy&view=day")
    expect(
      screen.getByRole("link", { name: "Next 30 days" }).getAttribute("href")
    ).toBe("/menu/mnu_spring/forecast?days=30&view=day")
    expect(
      screen.getByRole("link", { name: "Week" }).getAttribute("href")
    ).toBe("/menu/mnu_spring/forecast")
    expect(table(0).getAllByRole("columnheader")).toHaveLength(10)
    const cells = within(table(0).getAllByRole("row")[1]!).getAllByRole("cell")
    const sum = cells
      .slice(1, 8)
      .reduce((total, cell) => total + Number(cell.textContent), 0)
    expect(sum).toBe(Number(cells[8]!.textContent))
    const recipeCells = within(table(1).getAllByRole("row")[1]!).getAllByRole(
      "cell"
    )
    expect(
      recipeCells
        .slice(1, 8)
        .reduce((total, cell) => total + Number(cell.textContent), 0)
    ).toBe(Number(recipeCells[8]!.textContent))
  })

  it("groups the 30-day schedule by its five basis blocks, including the last two days", () => {
    const dates = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 3, 27 + i)).toISOString().slice(0, 10)
    )
    const horizon = Array.from({ length: 5 }, (_, i) => ({
      start: dates[i * 7]!,
      end: dates[Math.min(i * 7 + 6, 29)]!,
      typicalUnits: i === 4 ? 2 : 7,
      plannedUnits: i === 4 ? 2 : 7,
      lastYearUnits: 0,
    }))
    const forecast: MenuForecastData = {
      ...FORECAST,
      basis: {
        ...FORECAST.basis,
        horizonDays: 30,
        horizonEnd: dates[29]!,
        plan: "busy",
        weeks: { ...FORECAST.basis.weeks, horizon },
      },
      days: dates.map((date) => ({ date, typicalUnits: 1, plannedUnits: 1 })),
      products: [
        {
          ...FORECAST.products[0]!,
          totalQuantity: 30,
          busyQuantity: 30,
          days: dates.map((date) => ({
            date,
            typicalQuantity: 1,
            plannedQuantity: 1,
          })),
        },
      ],
      recipeRequirements: [
        {
          ...FORECAST.recipeRequirements[0]!,
          batches: 30,
          days: dates.map((date) => ({ date, batches: 1 })),
        },
      ],
    }
    render(
      <MenuForecast measurementSystem="metric" forecast={forecast} view="day" />
    )
    expect(screen.getByText("To make over the next 30 days")).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Week" }).getAttribute("href")
    ).toBe("/menu/mnu_spring/forecast?days=30&plan=busy")
    expect(table(0).getAllByRole("columnheader")).toHaveLength(8)
    const cells = within(table(0).getAllByRole("row")[1]!).getAllByRole("cell")
    expect(cells.slice(1, 6).map((cell) => Number(cell.textContent))).toEqual([
      7, 7, 7, 7, 2,
    ])
    expect(cells[6]!.textContent).toBe("30")
    const recipeCells = within(table(1).getAllByRole("row")[1]!).getAllByRole(
      "cell"
    )
    expect(
      recipeCells.slice(1, 6).map((cell) => Number(cell.textContent))
    ).toEqual([7, 7, 7, 7, 2])
  })

  it("shows the recent, matching last-year and coming basis side by side", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)
    const basis = within(screen.getByRole("table", { name: "Forecast basis" }))
    expect(basis.getAllByRole("row")).toHaveLength(10)
    expect(basis.getByRole("columnheader", { name: "Last year" })).toBeDefined()
    expect(
      screen.getByText(
        "Recent level: about 7 items a week, recent weeks counting more."
      )
    ).toBeDefined()
    expect(
      screen.getByText(
        "Last year’s comparison leaves the recent level unchanged."
      )
    ).toBeDefined()
  })
})
