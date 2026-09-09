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
  materialCost: { costCents: 0, costedMaterials: 0, uncostedMaterials: 1 },
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
    expect(screen.getByText("Modifier")).toBeDefined()
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

  it("heros the planned revenue with its accuracy and unpriced notes", () => {
    render(<MenuForecast measurementSystem="metric" forecast={FORECAST} />)

    expect(screen.getByText("Projected sales", { selector: "p" })).toBeDefined()
    expect(screen.getByText("$91")).toBeDefined()
    expect(
      screen.getByText("1 product has no price and is left out of the total.")
    ).toBeDefined()
    expect(
      screen.getByText(
        /within 12% of actual sales\. The busy plan covered 3 of 4 weeks with sales/
      )
    ).toBeDefined()
    // The other plan's figure, never the headline again.
    expect(screen.getByText("Busy plan $133")).toBeDefined()
    expect(screen.queryByText(/typical \$91/)).toBeNull()
    expect(
      screen.getByText(
        "No material has a pack size and a price yet, so there is no projected ingredient cost. 1 material has no pack size or price."
      )
    ).toBeDefined()
    expect(
      screen.getByText(
        /\$26 of actual sales over the last 2 days, then 1 projected days: \$91 typical, up to \$133 busy\./
      )
    ).toBeDefined()
    expect(screen.getAllByText(/for the typical plan/).length).toBe(2)
  })

  it("plans for busy without moving the busy column", () => {
    render(<MenuForecast measurementSystem="metric" forecast={busy()} />)

    expect(screen.getByText("$133")).toBeDefined()
    expect(screen.getByText("Typical plan $91")).toBeDefined()
    expect(screen.getAllByText(/for the busy plan/).length).toBe(2)
  })

  it("prices each product and shows its share of the projected sales", () => {
    const priced = (plan: "typical" | "busy") => ({
      ...(plan === "busy" ? busy() : FORECAST),
      products: [
        FORECAST.products[0]!,
        {
          ...FORECAST.products[1]!,
          weeksObserved: 8,
          priceCents: 450,
          typicalCents: 3600,
          busyCents: 5400,
        },
        {
          ...FORECAST.products[1]!,
          productId: "product-3",
          productPublicId: "prd_bun",
          productName: "Bun",
          weeksObserved: 3,
        },
      ],
    })
    const { unmount } = render(
      <MenuForecast measurementSystem="metric" forecast={priced("typical")} />
    )

    expect(screen.getByText("$4.50")).toBeDefined()
    expect(screen.getByText("$36")).toBeDefined()
    // An unpriced member is told so; a modifier's money sits in its base.
    expect(screen.getByText("No price")).toBeDefined()
    expect(screen.getByText("Full")).toBeDefined()
    expect(screen.getByText("3 of 8 weeks")).toBeDefined()

    fireEvent.click(table(0).getByRole("button", { name: "Projected sales" }))
    fireEvent.click(table(0).getByRole("button", { name: "Projected sales" }))
    expect(rowsOf(0)[0]).toBe("Scone")

    unmount()
    render(
      <MenuForecast measurementSystem="metric" forecast={priced("busy")} />
    )
    expect(screen.getByText("$54")).toBeDefined()
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
        "Projected ingredient cost $20, 22% of projected sales. 1 material has no pack size or price."
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
              yieldAmount: 4,
              yieldUnit: "l",
            },
            {
              recipeId: "recipe-3",
              recipePublicId: "rcp_glaze",
              recipeTitle: "Glaze",
              batches: 3,
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
})
