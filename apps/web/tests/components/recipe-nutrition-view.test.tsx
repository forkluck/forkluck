// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { NUTRIENT_KEYS } from "@/lib/backend/schemas"
import type {
  Nutrients,
  RecipeNutrition,
  RecipeNutritionLine,
} from "@/lib/backend/types"

const {
  refresh,
  registerSave,
  setDirty,
  setSaveState,
  setRecipeNutritionServing,
  setRecipeItemYieldAfterCooking,
  loadIngredientDetail,
  toastAdd,
} = vi.hoisted(() => ({
  refresh: vi.fn(),
  registerSave: vi.fn(),
  setDirty: vi.fn(),
  setSaveState: vi.fn(),
  setRecipeNutritionServing: vi.fn(),
  setRecipeItemYieldAfterCooking: vi.fn(),
  loadIngredientDetail: vi.fn(),
  toastAdd: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh, push: vi.fn() }),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  setRecipeNutritionServing,
  setRecipeItemYieldAfterCooking,
}))
vi.mock("@/app/(app)/ingredients/actions", () => ({
  loadIngredientDetail,
  searchNutritionFoods: vi.fn(),
  setIngredientNutrition: vi.fn(),
  clearIngredientNutrition: vi.fn(),
  replaceIngredientAllergens: vi.fn(),
  updateIngredientNutritionSettings: vi.fn(),
  requestCustomNutrition: vi.fn(),
}))
vi.mock("@/components/recipes/recipe-chrome", () => ({
  useRecipeEdit: () => ({ registerSave, setDirty, setSaveState }),
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    measurementSystem: "metric",
    labelRegion: "us",
  }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
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

import { RecipeNutritionView } from "@/components/recipes/recipe-nutrition-view"

function nutrients(
  amounts: Partial<Record<keyof Nutrients, number>>,
  incomplete: (keyof Nutrients)[] = []
): Nutrients {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [
      key,
      { amount: amounts[key] ?? 0, complete: !incomplete.includes(key) },
    ])
  ) as Nutrients
}

const line = (
  overrides: Partial<RecipeNutritionLine> & { itemId: string; name: string }
): RecipeNutritionLine => ({
  kind: "ingredient",
  hasAllergenHints: false,
  ingredientPublicId: "ing_1",
  subrecipePublicId: null,
  linkedDescription: "Butter, salted",
  linkedSource: "usda_fdc",
  nonEdible: false,
  efficiencyAfterCooking: 100,
  grams: 100,
  netGrams: 100,
  status: "linked",
  ...overrides,
})

const per100g = nutrients({ calories: 717, energyKj: 3000, fat: 81, salt: 1.6 })

const ready: RecipeNutrition = {
  recipeId: "recipe-1",
  publicId: "rcp_1",
  title: "Butter tart",
  permission: "owner",
  canEdit: true,
  serving: { amount: 50, unit: "g", grams: 50 },
  package: { amount: null, unit: "", grams: null },
  batch: {
    grams: 200,
    declaredGrams: 200,
    inputGrams: 200,
    servings: 4,
    containers: null,
  },
  lines: [
    line({ itemId: "item-1", name: "Butter" }),
    line({
      itemId: "item-2",
      name: "Brine",
      ingredientPublicId: "ing_2",
      efficiencyAfterCooking: 0,
      netGrams: 0,
      status: "discarded",
    }),
  ],
  totals: {
    batch: nutrients({ calories: 1434 }),
    per100g,
    perServing: nutrients({ calories: 358, energyKj: 1500, fat: 40.5 }),
  },
  allergens: { contains: ["milk"], mayContain: [] },
  statement: [{ name: "Butter", grams: 100, allergens: [] }],
  issues: { batch: [], serving: [] },
  readiness: {
    us: { ready: true, missing: [] },
    eu: { ready: true, missing: [] },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  setRecipeNutritionServing.mockResolvedValue({ ok: true })
  setRecipeItemYieldAfterCooking.mockResolvedValue({ ok: true })
  loadIngredientDetail.mockResolvedValue({ error: "Not loaded in this test." })
})

afterEach(cleanup)

function renderView(
  nutrition: RecipeNutrition,
  options: { owner?: boolean; canEdit?: boolean } = {}
) {
  return render(
    <RecipeNutritionView
      recipeId="recipe-1"
      owner={options.owner ?? true}
      canEdit={options.canEdit ?? true}
      recipeTitle="Butter tart"
      nutrition={nutrition}
    />
  )
}

describe("recipe nutrition view", () => {
  it("shows the checklist instead of the panel while a batch issue stands", () => {
    renderView({
      ...ready,
      lines: [
        line({
          itemId: "item-1",
          name: "Flour",
          linkedDescription: null,
          linkedSource: null,
          status: "unlinked",
        }),
      ],
      totals: { batch: null, per100g: null, perServing: null },
      issues: { batch: ["unlinkedIngredient", "noYield"], serving: [] },
      readiness: {
        us: { ready: false, missing: [] },
        eu: { ready: false, missing: [] },
      },
    })

    expect(screen.getByText("Before the preview can build")).not.toBeNull()
    expect(
      screen.getByText(
        "Link nutrition data to every ingredient, or mark it not food."
      )
    ).not.toBeNull()
    expect(
      screen.getByText("Give the recipe a total yield on the Recipe tab.")
    ).not.toBeNull()
    expect(screen.queryByText("Nutrition Facts")).toBeNull()
    expect(screen.getByLabelText("No nutrition data yet")).not.toBeNull()
    expect(screen.getByText("Add nutrition")).not.toBeNull()
  })

  it("keeps the EU table per 100 g when only the serving is missing", () => {
    renderView({
      ...ready,
      serving: { amount: null, unit: "", grams: null },
      batch: { ...ready.batch, servings: null },
      totals: { ...ready.totals, perServing: null },
      issues: { batch: [], serving: ["noServingSize"] },
      readiness: {
        us: { ready: false, missing: [] },
        eu: { ready: true, missing: [] },
      },
    })

    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    expect(screen.getAllByText("Set a serving size above.").length).toBe(1)
    expect(
      screen.getByLabelText("Set a serving size to build the preview.")
    ).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "EU" }))
    expect(screen.getByText("Per 100 g")).not.toBeNull()
    expect(screen.queryByText(/Per serving/)).toBeNull()
    expect(screen.getByText("3000 kJ")).not.toBeNull()
  })

  it("reddens the package field when it holds less than a serving", () => {
    renderView({
      ...ready,
      package: { amount: 20, unit: "g", grams: 20 },
      totals: { ...ready.totals, perServing: null },
      issues: { batch: [], serving: ["packageBelowServing"] },
    })

    const field = screen
      .getByLabelText("Package size amount")
      .closest("div") as HTMLElement
    expect(field.className).toContain("border-destructive")
    expect(
      screen.getByLabelText("A package can't be smaller than a serving.")
    ).not.toBeNull()
  })

  it("reddens the serving field when a serving is bigger than the batch", () => {
    renderView({
      ...ready,
      serving: { amount: 500, unit: "g", grams: 500 },
      totals: { ...ready.totals, perServing: null },
      issues: { batch: [], serving: ["servingAboveBatch"] },
    })

    const field = screen
      .getByLabelText("Serving size amount")
      .closest("div") as HTMLElement
    expect(field.className).toContain("border-destructive")
    expect(
      screen.getByLabelText("A serving can't be more than the batch makes.")
    ).not.toBeNull()
  })

  it("warns in amber, blocking nothing, when a container holds over 50 servings", () => {
    renderView({ ...ready, batch: { ...ready.batch, servings: 60 } })

    const field = screen
      .getByLabelText("Serving size amount")
      .closest("div") as HTMLElement
    expect(field.className).not.toContain("border-destructive")
    expect(
      screen.getByLabelText(
        "Check the units: that is 60 servings per container."
      )
    ).not.toBeNull()
    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
  })

  it("prints the known sum and names the missing nutrients when a record is thin", () => {
    renderView({
      ...ready,
      totals: {
        ...ready.totals,
        perServing: nutrients({ calories: 358, fat: 40.5, vitaminDMcg: 1 }, [
          "vitaminDMcg",
        ]),
      },
      readiness: {
        us: { ready: false, missing: ["vitaminDMcg"] },
        eu: { ready: true, missing: [] },
      },
    })

    expect(screen.getByText("Vitamin D").parentElement?.textContent).toBe(
      "Vitamin D 1mcg"
    )
    expect(
      screen.getByText(
        "The label counts only what the linked records report, so these are understated: Vitamin D. Link a fuller record or request a custom value."
      )
    ).not.toBeNull()
  })

  it("gives the owner the serving, the pencil and the source; a viewer reads", () => {
    const { unmount } = renderView(ready)
    expect(screen.getByLabelText("Serving size amount")).not.toBeNull()
    expect(
      screen.getByRole("button", { name: "Update nutrition for Butter" })
    ).not.toBeNull()
    expect(screen.getByText("Butter, salted")).not.toBeNull()
    expect(screen.getByText("Discarded")).not.toBeNull()
    expect(screen.getAllByLabelText("Yield after cooking").length).toBe(2)
    // Once as a read-only chip, once on the CONTAINS line.
    expect(screen.getAllByText("Milk").length).toBe(2)
    unmount()

    renderView(
      {
        ...ready,
        permission: "viewer",
        canEdit: false,
        lines: ready.lines.map((entry) => ({
          ...entry,
          ingredientPublicId: null,
          linkedDescription: null,
          linkedSource: null,
        })),
      },
      { owner: false, canEdit: false }
    )
    expect(
      screen.getByText(
        "Shared with you to read. The recipe owner links nutrition data."
      )
    ).not.toBeNull()
    expect(screen.queryByLabelText("Serving size amount")).toBeNull()
    expect(
      screen.queryByRole("button", { name: /Update nutrition/ })
    ).toBeNull()
    expect(screen.queryByText("Butter, salted")).toBeNull()
    expect(screen.getByText("Linked")).not.toBeNull()
    expect(screen.queryByLabelText("Yield after cooking")).toBeNull()
    expect(screen.getByText("100%")).not.toBeNull()
    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    expect(screen.getByRole("button", { name: "Print preview" })).not.toBeNull()
  })

  it("saves the yield after cooking only when it changed, and Escape restores it", async () => {
    renderView(ready)
    const [field] = screen.getAllByLabelText("Yield after cooking")

    fireEvent.blur(field)
    expect(setRecipeItemYieldAfterCooking).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "40" } })
    fireEvent.keyDown(field, { key: "Escape" })
    expect((field as HTMLInputElement).value).toBe("100")
    fireEvent.blur(field)
    expect(setRecipeItemYieldAfterCooking).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "120" } })
    fireEvent.blur(field)
    expect((field as HTMLInputElement).value).toBe("100")
    expect(setRecipeItemYieldAfterCooking).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "2" } })
    fireEvent.keyDown(field, { key: "Enter" })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(setRecipeItemYieldAfterCooking).toHaveBeenCalledWith(
        "recipe-1",
        "item-1",
        2
      )
    )
    // The action revalidates, so its answer is the refresh.
    expect(refresh).not.toHaveBeenCalled()
  })

  it("saves the serving size on blur when it changed", async () => {
    renderView(ready)
    const amount = screen.getByLabelText("Serving size amount")

    fireEvent.blur(amount)
    expect(setRecipeNutritionServing).not.toHaveBeenCalled()

    fireEvent.change(amount, { target: { value: "75" } })
    fireEvent.blur(amount)
    await waitFor(() =>
      expect(setRecipeNutritionServing).toHaveBeenCalledWith("recipe-1", {
        amount: 75,
        unit: "g",
      })
    )
    expect(setSaveState).toHaveBeenCalledWith("saving")
    await waitFor(() => expect(setSaveState).toHaveBeenCalledWith("saved"))
    expect(refresh).not.toHaveBeenCalled()
  })

  it("saves the package on blur and clears it when the amount goes", async () => {
    renderView({
      ...ready,
      package: { amount: 250, unit: "g", grams: 250 },
      batch: { ...ready.batch, servings: 5, containers: 4 },
    })
    expect(
      screen.getByRole("img", { name: "Fills 4 containers." })
    ).not.toBeNull()

    const amount = screen.getByLabelText("Package size amount")
    fireEvent.change(amount, { target: { value: "500" } })
    fireEvent.blur(amount)
    await waitFor(() =>
      expect(setRecipeNutritionServing).toHaveBeenCalledWith("recipe-1", {
        packageAmount: 500,
        packageUnit: "g",
      })
    )

    fireEvent.change(amount, { target: { value: "" } })
    fireEvent.blur(amount)
    await waitFor(() =>
      expect(setRecipeNutritionServing).toHaveBeenLastCalledWith("recipe-1", {
        packageAmount: null,
        packageUnit: "",
      })
    )
  })

  it("keeps the newly typed serving when header Save also saves a package", async () => {
    renderView({
      ...ready,
      package: { amount: 250, unit: "g", grams: 250 },
      batch: { ...ready.batch, servings: 5, containers: 4 },
    })

    fireEvent.change(screen.getByLabelText("Serving size amount"), {
      target: { value: "60" },
    })
    fireEvent.change(screen.getByLabelText("Package size amount"), {
      target: { value: "300" },
    })
    const headerSave = registerSave.mock.calls
      .map((call) => call[0])
      .filter(Boolean)
      .at(-1)!
    await headerSave()

    await waitFor(() =>
      expect(setRecipeNutritionServing).toHaveBeenCalledTimes(2)
    )
    expect(setRecipeNutritionServing).toHaveBeenLastCalledWith("recipe-1", {
      packageAmount: 300,
      packageUnit: "g",
    })
  })

  it("stays dirty when package autosave leaves a serving edit pending", async () => {
    renderView({
      ...ready,
      package: { amount: 250, unit: "g", grams: 250 },
      batch: { ...ready.batch, servings: 5, containers: 4 },
    })

    fireEvent.change(screen.getByLabelText("Serving size amount"), {
      target: { value: "60" },
    })
    const packageInput = screen.getByLabelText("Package size amount")
    fireEvent.change(packageInput, { target: { value: "300" } })
    fireEvent.blur(packageInput)

    await waitFor(() =>
      expect(setRecipeNutritionServing).toHaveBeenCalledWith("recipe-1", {
        packageAmount: 300,
        packageUnit: "g",
      })
    )
    expect(setDirty).toHaveBeenLastCalledWith(true)
  })

  it("refuses a package amount with no unit rather than dropping it", async () => {
    renderView(ready)

    const amount = screen.getByLabelText("Package size amount")
    fireEvent.change(amount, { target: { value: "250" } })

    const headerSave = registerSave.mock.calls
      .map((call) => call[0])
      .filter(Boolean)
      .at(-1)!
    await headerSave()

    expect(setRecipeNutritionServing).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith({
      title:
        "Enter a positive package amount and choose its unit, or clear both.",
      type: "error",
    })
  })

  it("tells the header why an incomplete serving cannot be saved", async () => {
    renderView({ ...ready, serving: { amount: null, unit: "", grams: null } })

    const amount = screen.getByLabelText("Serving size amount")
    fireEvent.change(amount, { target: { value: "75" } })

    const headerSave = registerSave.mock.calls
      .map((call) => call[0])
      .filter(Boolean)
      .at(-1)!
    await headerSave()

    expect(setRecipeNutritionServing).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Enter a positive serving amount and choose its unit.",
      type: "error",
    })
  })

  it("goes back to the confirmed serving when the server refuses", async () => {
    setRecipeNutritionServing.mockResolvedValue({ error: "Couldn’t save it." })
    renderView(ready)
    const amount = screen.getByLabelText("Serving size amount")

    fireEvent.change(amount, { target: { value: "75" } })
    fireEvent.blur(amount)

    await waitFor(() => expect((amount as HTMLInputElement).value).toBe("50"))
    expect(setSaveState).toHaveBeenCalledWith("error")
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t save it.",
      type: "error",
    })
  })

  it("goes back to the confirmed yield when the server refuses", async () => {
    setRecipeItemYieldAfterCooking.mockResolvedValue({ error: "No." })
    renderView(ready)
    const [field] = screen.getAllByLabelText("Yield after cooking")

    fireEvent.change(field!, { target: { value: "40" } })
    fireEvent.blur(field!)

    await waitFor(() =>
      expect(setRecipeItemYieldAfterCooking).toHaveBeenCalled()
    )
    await waitFor(() =>
      expect(
        (screen.getAllByLabelText("Yield after cooking")[0] as HTMLInputElement)
          .value
      ).toBe("100")
    )
    expect(toastAdd).toHaveBeenCalledWith({ title: "No.", type: "error" })
  })

  it("opens the line dialog from Add nutrition", async () => {
    renderView({
      ...ready,
      lines: [
        line({
          itemId: "item-1",
          name: "Flour",
          ingredientPublicId: "ing_9",
          linkedDescription: null,
          linkedSource: null,
          status: "unlinked",
        }),
      ],
      totals: { batch: null, per100g: null, perServing: null },
      issues: { batch: ["unlinkedIngredient"], serving: [] },
    })

    fireEvent.click(screen.getByText("Add nutrition"))
    expect(await screen.findByRole("dialog")).not.toBeNull()
    expect(screen.getByText("Update ingredient nutrition")).not.toBeNull()
    expect(loadIngredientDetail).toHaveBeenCalledWith("ing_9")
  })

  it("flags a line with allergen hints and opens its dialog", async () => {
    const { unmount } = renderView(ready)
    expect(
      screen.queryByRole("button", {
        name: "Allergen suggestions to confirm. Open the line.",
      })
    ).toBeNull()
    unmount()

    renderView({
      ...ready,
      lines: [
        line({
          itemId: "item-1",
          name: "Butter",
          ingredientPublicId: "ing_7",
          hasAllergenHints: true,
        }),
      ],
    })

    fireEvent.click(
      screen.getByRole("button", {
        name: "Allergen suggestions to confirm. Open the line.",
      })
    )
    expect(await screen.findByRole("dialog")).not.toBeNull()
    expect(loadIngredientDetail).toHaveBeenCalledWith("ing_7")
  })

  it("says what to do when the recipe has no lines", () => {
    renderView({ ...ready, lines: [] })
    expect(
      screen.getByText(
        "Add ingredients on the Recipe tab and the preview builds from them here."
      )
    ).not.toBeNull()
  })
})
