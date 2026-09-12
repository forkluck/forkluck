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
  COMPARE_MODE_KEY,
  COMPARE_PASTED_KEY,
  CompareFormulas,
} from "@/components/recipes/compare-formulas"
import type { FormulaInput } from "@/lib/recipe/compare"

const LOAF: FormulaInput = {
  key: "rcp_loaf",
  title: "Country loaf",
  source: "saved",
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
  { publicId: "rcp_loaf", title: "Country loaf" },
  { publicId: "rcp_brioche", title: "Brioche" },
  { publicId: "rcp_focaccia", title: "Focaccia" },
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
      {...extra}
    />
  )
}

/** The row whose first cell reads `label`, so cells can be read off it. */
function rowNamed(label: string): HTMLElement {
  const cell = screen
    .getAllByRole("cell")
    .find((one) => one.textContent?.trim().startsWith(label))
  if (!cell) throw new Error(`No row named ${label}`)
  return cell.closest("tr") as HTMLElement
}

function cellsOf(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent?.trim() ?? "")
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the compare page", () => {
  it("explains both ways in when there is nothing to compare", () => {
    page([])
    expect(
      screen.getByText("Compare recipes as baker’s percentages")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Paste recipe" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Add recipe/ })).toBeTruthy()
    expect(screen.queryByRole("table")).toBeNull()
  })

  it("reads every line against the flour lines together", () => {
    page([LOAF, BRIOCHE])
    expect(screen.getAllByRole("table")).toHaveLength(2)
    expect(
      screen.getAllByText("100% = Bread flour + Whole wheat flour")
    ).toHaveLength(1)
    expect(cellsOf(rowNamed("Bread flour"))).toEqual([
      "Bread flour",
      "500",
      "83.3%",
      "500",
      "100.0%",
      "+16.7",
    ])
    expect(cellsOf(rowNamed("Whole wheat flour")).slice(1)).toEqual([
      "100",
      "16.7%",
      "—",
      "—",
      "−16.7",
    ])
    expect(cellsOf(rowNamed("Water")).slice(1)).toEqual([
      "400",
      "66.7%",
      "—",
      "—",
      "−66.7",
    ])
    expect(cellsOf(rowNamed("Flour total")).slice(1)).toEqual([
      "600",
      "100.0%",
      "500",
      "100.0%",
      "0.0",
    ])
    expect(cellsOf(rowNamed("Total")).slice(1)).toEqual([
      "1,012",
      "168.7%",
      "910",
      "182.0%",
      "+13.3",
    ])
    // The formula summary reads hydration off the liquid lines.
    expect(cellsOf(rowNamed("Hydration")).slice(1)).toEqual([
      "66.7%",
      "50.0%",
      "−16.7",
    ])
  })

  it("keeps an unweighed line on the page with a box for its grams", async () => {
    page([LOAF, BRIOCHE])
    const almond = rowNamed("Almond flour")
    expect(cellsOf(almond).slice(1)).toEqual(["—", "—", "1 cup", "—", "—"])
    expect(screen.getByText("1 line without a weight")).toBeTruthy()
    const input = within(almond).getByLabelText(
      "Grams for Almond flour in Brioche"
    )
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "50" } })
    fireEvent.blur(input)
    // The field stays once filled: the number is the page's, not the recipe's.
    await waitFor(() => {
      expect(cellsOf(rowNamed("Almond flour")).slice(1)).toEqual([
        "—",
        "—",
        "",
        "9.1%",
        "+9.1",
      ])
    })
    expect(
      (
        within(rowNamed("Almond flour")).getByLabelText(
          "Grams for Almond flour in Brioche"
        ) as HTMLInputElement
      ).value
    ).toBe("50")
    // Almond flour is a flour line, so the brioche's 100% grew with it.
    expect(cellsOf(rowNamed("Flour total")).slice(3)).toEqual([
      "550",
      "100.0%",
      "0.0",
    ])
    expect(screen.queryByText("1 line without a weight")).toBeNull()
  })

  it("moves a row to the group chosen for it, in every column", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(
      screen.getByRole("button", { name: "Group for Almond flour" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fats" }))
    await waitFor(() => {
      expect(cellsOf(rowNamed("Fats total")).slice(1)).toEqual([
        "0",
        "0.0%",
        "150",
        "30.0%",
        "+30.0",
      ])
    })
  })

  it("switches to shares of the whole and remembers it", async () => {
    page([LOAF])
    fireEvent.click(screen.getByRole("button", { name: "Show: Baker’s %" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Weight %" }))
    await waitFor(() => {
      expect(cellsOf(rowNamed("Water")).slice(1)).toEqual(["400", "39.5%"])
    })
    expect(screen.getByText("Share of total weight")).toBeTruthy()
    expect(window.localStorage.getItem(COMPARE_MODE_KEY)).toBe("weight")
    cleanup()
    page([LOAF])
    await waitFor(() => {
      expect(cellsOf(rowNamed("Water")).slice(1)).toEqual(["400", "39.5%"])
    })
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
    // The title heads both tables.
    await waitFor(() => {
      expect(screen.getAllByText("Serious Eats focaccia")).toHaveLength(2)
    })
    expect(screen.getByText("Pasted")).toBeTruthy()
    expect(cellsOf(rowNamed("Water")).slice(1)).toEqual([
      "400",
      "66.7%",
      "380",
      "76.0%",
      "+9.3",
    ])
    // Two cups of oil with no pantry to weigh them keep their row.
    expect(cellsOf(rowNamed("Olive oil")).slice(1)).toEqual([
      "—",
      "—",
      "2 cups",
      "—",
      "—",
    ])
    const stored = JSON.parse(
      window.localStorage.getItem(COMPARE_PASTED_KEY) ?? "[]"
    ) as Array<{ title: string; text: string }>
    expect(stored).toHaveLength(1)
    expect(stored[0]?.title).toBe("Serious Eats focaccia")
    expect(stored[0]?.text).toContain("380 g water")

    // Removing a pasted column is this browser's business alone.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Serious Eats focaccia" })
    )
    await waitFor(() => {
      expect(screen.queryAllByText("Serious Eats focaccia")).toHaveLength(0)
    })
    expect(window.localStorage.getItem(COMPARE_PASTED_KEY)).toBe("[]")
    expect(go).not.toHaveBeenCalled()
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
      expect(screen.getAllByText("From the book")).toHaveLength(2)
    })
    expect(cellsOf(rowNamed("Water")).slice(1)).toEqual(["300", "60.0%"])
  })

  it("rewrites the URL to add or remove a saved recipe", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Remove Brioche" }))
    expect(go).toHaveBeenCalledWith("/recipes/compare?r=rcp_loaf", {
      replace: true,
    })
    fireEvent.click(screen.getByRole("button", { name: /Add recipe/ }))
    const chosen = await screen.findByRole("menuitem", { name: "Country loaf" })
    expect(chosen.hasAttribute("data-disabled")).toBe(true)
    fireEvent.click(screen.getByRole("menuitem", { name: "Focaccia" }))
    expect(go).toHaveBeenCalledWith(
      "/recipes/compare?r=rcp_loaf,rcp_brioche,rcp_focaccia",
      { replace: true }
    )
  })

  it("says how many selected recipes could not be opened", () => {
    page([LOAF], { missingCount: 2 })
    expect(
      screen.getByText("2 selected recipes could not be opened.")
    ).toBeTruthy()
  })
})
