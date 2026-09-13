// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

/**
 * The compare editor: recipes from the URL and pasted ones from the page,
 * side by side as a baker reads them, saved the way a menu is: a name, the
 * header's Save, a leave guard, and a draft this browser keeps.
 */

const replace = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  usePathname: () => "/recipes/compare/new",
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
}))

const toastAdd = vi.hoisted(() => vi.fn())
const saveComparison = vi.hoisted(() => vi.fn())
const deleteComparison = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD", timezone: "UTC" }),
}))
vi.mock("@/app/(app)/recipes/compare/actions", () => ({
  saveComparison: (...args: unknown[]) => saveComparison(...args),
  deleteComparison: (...args: unknown[]) => deleteComparison(...args),
}))
// The pantry dialog is the recipe page's; here it only has to report a link.
const linkedEntry = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/components/ingredients/price-line-dialog", () => ({
  PriceLineDialog: ({
    lineName,
    open,
    onLinked,
  }: {
    lineName: string
    open?: boolean
    onLinked?: (match: { line: string; entry: unknown }) => void
  }) =>
    open ? (
      <div role="dialog" aria-label={`Price ${lineName}`}>
        <button
          type="button"
          onClick={() =>
            onLinked?.({
              line: lineName.toLowerCase(),
              entry: linkedEntry.current,
            })
          }
        >
          Confirm link
        </button>
      </div>
    ) : null,
}))

import { CompareChrome } from "@/components/recipes/compare-chrome"
import {
  CompareFormulas,
  compareRowStats,
  formatCompareDeltaPoints,
  formatCompareGrams,
  formatComparePercent,
  formulaAxisMax,
  type SavedComparisonState,
} from "@/components/recipes/compare-formulas"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import type { FormulaInput } from "@/lib/recipe/compare"
import type { PriceListEntry } from "@/lib/pricing"

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

const SAVED: SavedComparisonState = {
  id: "uuid-1",
  publicId: "cmp_loaves",
  title: "Loaves",
  editVersion: 2,
  missingCount: 0,
  pasted: [],
  percentMode: "bakers",
  showGrams: false,
  overrides: { grams: {}, roles: {} },
}

/** The pill in the header, which the tests read as the save's state. */
const badge = () => screen.getByRole("status").textContent

const leaveAnswers: boolean[] = []
function LeaveButton() {
  const { confirmNavigation } = useNavigationBlocker()
  return (
    <button
      type="button"
      onClick={() => {
        void confirmNavigation().then((answer) => leaveAnswers.push(answer))
      }}
    >
      Leave
    </button>
  )
}

function page(
  formulas: FormulaInput[],
  extra: Partial<React.ComponentProps<typeof CompareFormulas>> = {}
) {
  const saved = extra.saved ?? null
  return render(
    <NavigationBlockerProvider>
      <CompareChrome
        title={saved ? saved.title : "New comparison"}
        publicId={saved?.publicId}
      >
        <CompareFormulas
          selected={formulas.map((formula) => formula.key)}
          formulas={formulas}
          missingCount={0}
          identities={[]}
          recipeOptions={OPTIONS}
          view="formula"
          baseId={null}
          currentUserId="user-1"
          {...extra}
        />
      </CompareChrome>
      <LeaveButton />
    </NavigationBlockerProvider>
  )
}

const nameField = () => screen.getByLabelText("Name (required)")

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/recipes/compare/new")
  leaveAnswers.length = 0
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
  it("starts empty and explains both ways in", () => {
    page([])
    expect(
      screen.getByText("Compare recipes as baker's percentages")
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Paste recipe" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Add recipe/ })).toBeTruthy()
    expect(screen.queryByText("Baker's %")).toBeNull()
    expect(badge()).toBe("")
    // The name is there from the start: it is what the header's Save asks for.
    expect(nameField()).toBeTruthy()
  })

  it("shows the name, the view tabs, column headers and collapsed groups", () => {
    page([LOAF, BRIOCHE])
    expect(nameField()).toBeTruthy()
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

  it("switches to weight percentages and reads as changed", async () => {
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
    expect(badge()).toBe("Draft")
  })

  it("sets and clears the baseline from a column header", () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Country loaf" }))
    expect(replace).toHaveBeenCalledWith(
      "/recipes/compare/new?r=rcp_loaf,rcp_brioche&view=formula&base=rcp_loaf"
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
    expect(replace).toHaveBeenLastCalledWith(
      "/recipes/compare/new?r=rcp_loaf,rcp_brioche&view=formula"
    )
  })

  it("keeps the recovery draft's id on every move", () => {
    window.history.replaceState(null, "", "/recipes/compare/new?draft=d-1")
    page([LOAF])
    fireEvent.click(screen.getByRole("button", { name: "Spec sheet" }))
    expect(replace).toHaveBeenLastCalledWith(
      "/recipes/compare/new?r=rcp_loaf&view=spec&draft=d-1"
    )
  })

  it("shows a single recipe on its own and lets it be removed", () => {
    page([LOAF])
    expect(screen.getByRole("table")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Country loaf" }))
    expect(replace).toHaveBeenCalledWith("/recipes/compare/new?view=formula")
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
    expect(replace).toHaveBeenCalledWith(
      "/recipes/compare/new?r=rcp_loaf,rcp_brioche,rcp_focaccia&view=formula"
    )
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
    // A number the page was told is part of what it saves.
    expect(badge()).toBe("Draft")
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

  it("shows weights in the formula view", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Show weights" })
    )
    expect(screen.getByText("600 g")).toBeTruthy()
  })

  it("renders the spec sheet as composition, one column per recipe", () => {
    page([LOAF, BRIOCHE], { view: "spec", baseId: "rcp_loaf" })
    expect(screen.getByText("Pastry")).toBeTruthy()
    expect(screen.getByText("600 g flour · 1,012 g dough")).toBeTruthy()
    expect(screen.getByText("500 g flour · 910 g dough")).toBeTruthy()
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
    expect(screen.getByText("−16.7 pts")).toBeTruthy()
    expect(screen.getAllByText(/Profiles cover/)).toHaveLength(2)
  })

  it("adds a pasted recipe and edits it in place", async () => {
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
    // Nothing of it is this browser's business any more.
    expect(window.localStorage.getItem("recipe.compare.pasted")).toBeNull()

    // Edit: the dialog opens on what was pasted and replaces it.
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Serious Eats focaccia" })
    )
    const edit = await screen.findByRole("dialog")
    expect(within(edit).getByText("Edit pasted recipe")).toBeTruthy()
    expect(
      (within(edit).getByLabelText("Ingredients") as HTMLTextAreaElement).value
    ).toContain("380 g water")
    fireEvent.change(within(edit).getByLabelText("Name"), {
      target: { value: "Focaccia, wetter" },
    })
    fireEvent.change(within(edit).getByLabelText("Ingredients"), {
      target: { value: "500 g bread flour\n420 g water\n10 g salt" },
    })
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Focaccia, wetter" })
      ).toBeTruthy()
    })
    expect(screen.getByTitle("Focaccia, wetter · 84.0%")).toBeTruthy()
    expect(badge()).toBe("Draft")
  })

  it("weighs a pasted count by the pantry's piece size", async () => {
    const egg: PriceListEntry = {
      id: "egg",
      name: "Egg",
      normalizedName: "egg",
      measureName: "Egg",
      purchaseCostCents: 100,
      conversion: {
        usesStandardConversion: false,
        weight: { amount: 62, unit: "g" },
        volume: null,
        each: { amount: 1, unit: "pcs" },
      },
    }
    page([LOAF], { identities: [egg] })
    fireEvent.click(screen.getByRole("button", { name: "Paste recipe" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Ingredients"), {
      target: { value: "500 g flour\n4 eggs" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    // 248 g of egg on 500 g of flour: no grams box, no "Recipe says".
    expect(await screen.findByTitle("Pasted recipe 1 · 49.6%")).toBeTruthy()
    expect(screen.queryByText(/Recipe says/)).toBeNull()
  })

  it("names the lines no profile describes and links a pasted one", async () => {
    const bourbon: PriceListEntry = {
      id: "bourbon",
      name: "Bourbon whiskey",
      normalizedName: "bourbon whiskey",
      measureName: "Bourbon whiskey",
      purchaseCostCents: 100,
      nutritionPer100g: {
        calories: 231,
        fat: 0,
        protein: 0,
        carbs: 0,
        sugars: 0,
        fiber: 0,
        salt: 0,
        water: 60,
      } as unknown as PriceListEntry["nutritionPer100g"],
    }
    linkedEntry.current = bourbon
    page([LOAF], { identities: [bourbon], view: "spec" })
    fireEvent.click(screen.getByRole("button", { name: "Paste recipe" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Ingredients"), {
      target: { value: "500 g flour\n30 g bourbon" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    // The spec sheet says which line it is, not just that there is one.
    expect(
      await screen.findByText(/Profiles cover .* · unmapped: bourbon/)
    ).toBeTruthy()

    // The formula view marks the row and offers the pantry.
    fireEvent.click(screen.getByRole("button", { name: "Formula" }))
    cleanup()
    page([LOAF], { identities: [bourbon] })
    fireEvent.click(screen.getByRole("button", { name: "Paste recipe" }))
    const again = await screen.findByRole("dialog")
    fireEvent.change(within(again).getByLabelText("Ingredients"), {
      target: { value: "500 g flour\n30 g bourbon" },
    })
    fireEvent.click(within(again).getByRole("button", { name: "Add" }))
    expect(await screen.findByText("No profile")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Link to ingredient" }))
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Price bourbon" })
      ).getByRole("button", { name: "Confirm link" })
    )
    // Linked, the line reads under the pantry's name with its profile.
    await waitFor(() => {
      expect(screen.queryByText("No profile")).toBeNull()
    })
  })

  it("says how many selected recipes could not be opened", () => {
    page([LOAF], { missingCount: 2 })
    expect(
      screen.getByText("2 selected recipes could not be opened.")
    ).toBeTruthy()
  })

  it("refuses to save without a name and says so", async () => {
    page([LOAF, BRIOCHE])
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Give the comparison a name",
        type: "error",
      })
    })
    expect(saveComparison).not.toHaveBeenCalled()
    expect(nameField().getAttribute("aria-invalid")).toBe("true")
  })

  it("saves a new comparison whole and moves to its address", async () => {
    saveComparison.mockResolvedValue({
      id: "uuid-1",
      publicId: "cmp_loaves",
      title: "Loaves",
      editVersion: 0,
    })
    page([LOAF, BRIOCHE], { baseId: "rcp_brioche" })
    fireEvent.change(nameField(), { target: { value: "Loaves" } })
    expect(badge()).toBe("Draft")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(saveComparison).toHaveBeenCalledTimes(1)
    })
    expect(saveComparison).toHaveBeenCalledWith({
      id: null,
      title: "Loaves",
      view: "formula",
      baselinePosition: 1,
      percentMode: "bakers",
      showGrams: false,
      overrides: { grams: {}, roles: {} },
      columns: [{ recipeId: "rcp_loaf" }, { recipeId: "rcp_brioche" }],
    })
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/recipes/compare/cmp_loaves?r=rcp_loaf,rcp_brioche&view=formula&base=rcp_brioche"
      )
    })
    expect(toastAdd).toHaveBeenCalledWith({ title: "Comparison saved" })
  })

  it("saves changes to an open comparison against its version", async () => {
    saveComparison.mockResolvedValue({
      id: "uuid-1",
      publicId: "cmp_loaves",
      title: "Loaves, spring",
      editVersion: 3,
    })
    page([LOAF], {
      saved: {
        ...SAVED,
        showGrams: true,
        pasted: [
          { id: "saved-1", title: "From the book", text: "500 g flour" },
        ],
      },
      baseId: "paste:saved-1",
    })
    // The pasted column is the record's, so it is there at once.
    expect(
      screen.getByRole("button", { name: "From the book baseline" })
    ).toBeTruthy()
    expect(badge()).toBe("Saved")
    fireEvent.change(nameField(), { target: { value: "Loaves, spring" } })
    expect(badge()).toBe("Draft")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(saveComparison).toHaveBeenCalledWith({
        id: "uuid-1",
        expectedEditVersion: 2,
        title: "Loaves, spring",
        view: "formula",
        baselinePosition: 1,
        percentMode: "bakers",
        showGrams: true,
        overrides: { grams: {}, roles: {} },
        columns: [
          { recipeId: "rcp_loaf" },
          { pastedTitle: "From the book", pastedText: "500 g flour" },
        ],
      })
    })
    // An update stays where it is.
    expect(replace).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(badge()).toBe("Saved")
    })
  })

  it("saves on the way out and leaves without asking", async () => {
    saveComparison.mockResolvedValue({
      id: "uuid-1",
      publicId: "cmp_loaves",
      title: "Loaves",
      editVersion: 0,
    })
    page([LOAF])
    fireEvent.change(nameField(), { target: { value: "Loaves" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    })
    await waitFor(() => {
      expect(leaveAnswers).toEqual([true])
    })
    expect(saveComparison).toHaveBeenCalledTimes(1)
    // Leaving rewrites the entry being left; it never navigates.
    expect(replace).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/recipes/compare/cmp_loaves")
    expect(screen.queryByText("Leave without saving?")).toBeNull()
  })

  it("shows the conflict banner when the record changed elsewhere", async () => {
    saveComparison.mockResolvedValue({
      error: "Someone else saved this comparison.",
      code: "stale_write",
      editVersion: 5,
    })
    page([LOAF], { saved: SAVED })
    fireEvent.change(nameField(), { target: { value: "Loaves, later" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => {
      expect(badge()).toBe("Changed elsewhere")
    })
    expect(screen.getByText("Someone else saved this comparison.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy()
  })

  it("deletes an open comparison after confirming", async () => {
    deleteComparison.mockResolvedValue({ ok: true })
    page([LOAF], { saved: SAVED })
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete comparison" })
    )
    await waitFor(() => {
      expect(deleteComparison).toHaveBeenCalledWith("uuid-1")
    })
    await waitFor(() => {
      expect(replace).toHaveBeenLastCalledWith("/recipes/compare")
    })
  })
})
