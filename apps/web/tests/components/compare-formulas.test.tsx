// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

/**
 * The compare page: saved recipes from the URL and pasted ones from this
 * browser, side by side as a baker reads them, with nothing a recipe wrote
 * dropped because it could not be weighed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const go = vi.hoisted(() => vi.fn())
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go, pending: false }),
  GuardedLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children?: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

import {
  COMPARE_GRAMS_KEY,
  COMPARE_MODE_KEY,
  COMPARE_PASTED_KEY,
  CompareFormulas,
  compareRowStats,
  formatCompareDeltaPoints,
  formatCompareGrams,
  formatComparePercent,
  formulaAxisMax,
} from "@/components/recipes/compare-formulas"
import type { FormulaInput } from "@/lib/recipe/compare"

const LOAF: FormulaInput = {
  key: "rcp_loaf",
  title: "Country loaf",
  source: "saved",
  category: "Bread",
  href: "/recipes/rcp_loaf/recipe",
  lines: [
    { id: "1", name: "Bread flour", grams: 500, written: "500 g" },
    { id: "2", name: "Whole wheat flour", grams: 100, written: "100 g" },
    { id: "3", name: "Water", grams: 400, written: "400 g" },
    { id: "4", name: "Fine sea salt", grams: 12, written: "12 g" },
  ],
}

const BRIOCHE: FormulaInput = {
  key: "rcp_brioche",
  title: "Brioche",
  source: "saved",
  category: "Pastry",
  href: "/recipes/rcp_brioche/recipe",
  lines: [
    { id: "1", name: "Bread flour", grams: 500, written: "500 g" },
    { id: "2", name: "Whole milk", grams: 250, written: "250 g" },
    { id: "3", name: "Unsalted butter", grams: 150, written: "150 g" },
    { id: "4", name: "Fine sea salt", grams: 10, written: "10 g" },
    { id: "5", name: "Almond flour", grams: null, written: "1 cup" },
  ],
}

const OPTIONS = [
  { publicId: "rcp_loaf", title: "Country loaf", category: "Bread" },
  { publicId: "rcp_brioche", title: "Brioche", category: "Pastry" },
  { publicId: "rcp_focaccia", title: "Focaccia", category: "Bread" },
]

function page(
  formulas: FormulaInput[],
  extra: Partial<React.ComponentProps<typeof CompareFormulas>> = {}
) {
  return render(
    <CompareFormulas
      selected={formulas.map((formula) => formula.key)}
      formulas={formulas}
      missingCount={0}
      identities={[]}
      recipeOptions={OPTIONS}
      view="formula"
      baseId={null}
      {...extra}
    />
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(crypto, "randomUUID").mockReturnValue("paste-1")
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("compare formatting", () => {
  it("prints percents, points and grams for the compare views", () => {
    expect(formatComparePercent(1250)).toBe("1,250.0%")
    expect(formatComparePercent(null)).toBe("—")
    expect(formatCompareDeltaPoints(4.5)).toBe("+4.5 pts")
    expect(formatCompareDeltaPoints(-12)).toBe("−12.0 pts")
    expect(formatCompareDeltaPoints(0.04)).toBe("same")
    expect(formatCompareGrams(1499.6)).toBe("1,500 g")
  })

  it("finds per-row spread and widens the axis above 100", () => {
    expect(compareRowStats([null, 40, 52.5, 52.6])).toEqual({
      min: 40,
      max: 52.6,
      spread: 12.6,
    })
    expect(formulaAxisMax([null, 99.9, 100])).toBe(100)
    expect(formulaAxisMax([101])).toBe(150)
    expect(formulaAxisMax([150])).toBe(200)
  })
})

describe("the compare page", () => {
  it("explains both ways in when there is nothing to compare", () => {
    page([])
    expect(
      screen.getByText("Compare recipes as baker's percentages")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Paste recipe" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Add recipe/ })).toBeTruthy()
    expect(screen.queryByText("Baker's %")).toBeNull()
  })

  it("shows the view tabs, column headers and collapsed formula groups", () => {
    page([LOAF, BRIOCHE])
    expect(screen.getByRole("table")).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Baker's %" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Country loaf" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Brioche" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Formula" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Spec sheet" })).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Flour" })
        .getAttribute("aria-expanded")
    ).toBe("false")
    expect(screen.queryByText("Whole wheat flour")).toBeNull()
    expect(screen.getByTitle("Country loaf · 66.7%")).toBeTruthy()
  })

  it("switches to weight percentages and remembers it", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Weight %" }))
    await waitFor(() => {
      expect(
        screen.getByRole("columnheader", { name: "Weight %" })
      ).toBeTruthy()
    })
    expect(screen.getByRole("button", { name: "Liquids" })).toBeTruthy()
    expect(screen.queryByText("Hydration")).toBeNull()
    expect(window.localStorage.getItem(COMPARE_MODE_KEY)).toBe("weight")
  })

  it("sets and clears the baseline from a column header", () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Country loaf" }))
    expect(go).toHaveBeenCalledWith(
      "/recipes/compare?r=rcp_loaf,rcp_brioche&view=formula&base=rcp_loaf",
      { replace: true }
    )

    cleanup()
    page([LOAF, BRIOCHE], { baseId: "rcp_loaf" })
    expect(
      screen
        .getByRole("button", { name: "Country loaf baseline" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(screen.getByText("−16.7 pts")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Country loaf baseline" })
    )
    expect(go).toHaveBeenLastCalledWith(
      "/recipes/compare?r=rcp_loaf,rcp_brioche&view=formula",
      { replace: true }
    )
  })

  it("shows a single recipe on its own and lets it be removed", () => {
    page([LOAF])
    expect(screen.getByRole("table")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Country loaf" }))
    expect(go).toHaveBeenCalledWith("/recipes/compare?view=formula", {
      replace: true,
    })
  })

  it("filters the add popover and picks a recipe", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: /Add recipe/ }))
    const search = await screen.findByRole("searchbox", {
      name: "Search recipes",
    })
    const selectedOption = screen
      .getAllByRole("button", { name: /Country loaf/ })
      .find((button) => button.textContent?.includes("Bread"))
    expect(selectedOption?.hasAttribute("disabled")).toBe(true)
    fireEvent.change(search, { target: { value: "foc" } })
    expect(screen.queryByText("Pastry")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Focaccia/ }))
    expect(go).toHaveBeenCalledWith(
      "/recipes/compare?r=rcp_loaf,rcp_brioche,rcp_focaccia&view=formula",
      { replace: true }
    )
  })

  it("opens the paste dialog from the add popover empty result", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: /Add recipe/ }))
    const search = await screen.findByRole("searchbox", {
      name: "Search recipes",
    })
    fireEvent.change(search, { target: { value: "zzz" } })
    expect(screen.getByText("No recipes match")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Paste a recipe" }))
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it("expands formula groups and keeps unweighed lines editable", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Flour" }))
    expect(screen.getByText("Whole wheat flour")).toBeTruthy()
    const input = screen.getByLabelText("Grams for Almond flour in Brioche")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "50" } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(
        (
          screen.getByLabelText(
            "Grams for Almond flour in Brioche"
          ) as HTMLInputElement
        ).value
      ).toBe("50")
    })
  })

  it("moves a row to the group chosen for it", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Flour" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Group for Almond flour" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fats" }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Fats" })).toBeTruthy()
    })
  })

  it("shows and remembers weights in the formula view", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Show weights" })
    )
    expect(window.localStorage.getItem(COMPARE_GRAMS_KEY)).toBe("shown")
    expect(screen.getByText("600 g")).toBeTruthy()

    cleanup()
    page([LOAF, BRIOCHE])
    await waitFor(() => {
      expect(screen.getByText("600 g")).toBeTruthy()
    })
  })

  it("renders the spec sheet as composition, one column per recipe", () => {
    page([LOAF, BRIOCHE], { view: "spec", baseId: "rcp_loaf" })
    expect(screen.getByText("Pastry")).toBeTruthy()
    expect(screen.getByText("600 g flour · 1,012 g dough")).toBeTruthy()
    expect(screen.getByText("500 g flour · 910 g dough")).toBeTruthy()
    // What comes out, not what goes in: water, fat, sugars, protein, salt
    // and solids from the profiles, hydration from the liquid group.
    for (const label of [
      "Hydration",
      "Total water",
      "Fat",
      "Sugars",
      "Protein",
      "Salt",
      "Total solids",
    ]) {
      expect(screen.getAllByText(label)).toHaveLength(2)
    }
    // Hydration: 400 / 600 against 250 / 500, so −16.7 points.
    expect(screen.getByText("−16.7 pts")).toBeTruthy()
    // The brioche's fat is all butter; the loaf has next to none.
    const fat = screen
      .getAllByText("Fat")
      .map((heading) => heading.parentElement?.textContent)
    expect(fat.some((text) => text?.includes("pts"))).toBe(true)
    expect(screen.getAllByText(/Profiles cover/)).toHaveLength(2)
  })

  it("shares the composition on the column's basis", () => {
    page([LOAF], { view: "spec" })
    // Total solids are a share of the covered weight whatever the mode.
    expect(screen.getByText("· of covered weight")).toBeTruthy()
  })

  it("adds a pasted recipe as a column of this browser's own", async () => {
    page([LOAF])
    fireEvent.click(screen.getByRole("button", { name: "Paste recipe" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Paste the ingredient list first."
    )
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Serious Eats focaccia" },
    })
    fireEvent.change(within(dialog).getByLabelText("Ingredients"), {
      target: {
        value: "500 g bread flour\n380 g water\n10 g salt\n2 cups olive oil",
      },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Serious Eats focaccia" })
      ).toBeTruthy()
    })
    expect(
      screen.getByLabelText("Grams for Olive oil in Serious Eats focaccia")
    ).toBeTruthy()
    const stored = JSON.parse(
      window.localStorage.getItem(COMPARE_PASTED_KEY) ?? "[]"
    ) as Array<{ title: string; text: string }>
    expect(stored).toHaveLength(1)
    expect(stored[0]?.title).toBe("Serious Eats focaccia")
    expect(stored[0]?.text).toContain("380 g water")
  })

  it("brings a pasted recipe back on the next visit", async () => {
    window.localStorage.setItem(
      COMPARE_PASTED_KEY,
      JSON.stringify([
        { id: "p1", title: "From the book", text: "500 g flour\n300 g water" },
        { broken: true },
      ])
    )
    page([])
    await waitFor(() => {
      expect(screen.getAllByText("From the book").length).toBeGreaterThan(0)
    })
    expect(screen.getByRole("table")).toBeTruthy()
  })

  it("says how many selected recipes could not be opened", () => {
    page([LOAF], { missingCount: 2 })
    expect(
      screen.getByText("2 selected recipes could not be opened.")
    ).toBeTruthy()
  })
})
