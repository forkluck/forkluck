// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { IngredientDetail } from "@/lib/backend/types"

const {
  refresh,
  saveRef,
  setDirty,
  setSaveState,
  toastAdd,
  replaceIngredientAllergens,
  updateIngredientNutritionSettings,
  setIngredientNutrition,
  clearIngredientNutrition,
} = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveRef: { current: null } as { current: (() => Promise<unknown>) | null },
  setDirty: vi.fn(),
  setSaveState: vi.fn(),
  toastAdd: vi.fn(),
  replaceIngredientAllergens: vi.fn(),
  updateIngredientNutritionSettings: vi.fn(),
  setIngredientNutrition: vi.fn(),
  clearIngredientNutrition: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}))
vi.mock("@/app/(app)/ingredients/actions", () => ({
  replaceIngredientAllergens,
  updateIngredientNutritionSettings,
  setIngredientNutrition,
  clearIngredientNutrition,
  searchNutritionFoods: vi.fn(),
  requestCustomNutrition: vi.fn(),
}))
vi.mock("@/components/ingredients/ingredient-chrome", () => ({
  useIngredientEdit: () => ({ saveRef, setDirty, setSaveState }),
  useIngredientTabSave: () => undefined,
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

import { IngredientNutritionPanel } from "@/components/ingredients/ingredient-nutrition-panel"

const ingredient = {
  id: "00000000-0000-0000-0000-000000000001",
  publicId: "ing_test",
  editVersion: 0,
  userId: "user_test",
  name: "Peanut butter",
  normalizedName: "peanut butter",
  measureName: "g",
  purchaseCostCents: 500,
  purchaseSize: 500,
  purchaseUnit: "g",
  yieldPercent: 100,
  priceSource: "user" as const,
  tags: [],
  effectiveAllergenKeys: ["milk", "egg", "peanut"],
  categoryId: null,
  category: null,
  status: "active" as const,
  usedInRecipes: [],
  usedInProducts: [],
  previousPrice: null,
  preferredSupplier: null,
  needsAttention: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
  priceHistory: [],
  supplierItems: [],
  invoicePrices: [],
  preparations: [],
  conversion: null,
  effectiveAllergens: [
    { key: "milk", status: "mayContain" as const, source: "catalog" as const },
    { key: "egg", status: "contains" as const, source: "user" as const },
    { key: "peanut", status: "contains" as const, source: "catalog" as const },
    {
      key: "soy",
      status: "doesNotContain" as const,
      source: "catalog" as const,
    },
  ],
} satisfies IngredientDetail

const pendingRequest: IngredientDetail = {
  ...ingredient,
  nutritionRequest: {
    id: "req_1",
    status: "pending",
    servingGrams: 14,
    source: "American Almond Almond Paste, 7 LB",
    note: "From the pack",
    createdAt: new Date(),
    values: {
      calories: 100,
      fat: 11,
      saturatedFat: 7,
      transFat: 0,
      cholesterolMg: 30,
      sodiumMg: 90,
      totalCarbohydrate: 0,
      fiber: null,
      sugars: 0,
      addedSugars: null,
      protein: 0,
      vitaminDMcg: null,
      calciumMg: null,
      ironMg: null,
      potassiumMg: null,
    },
  },
}

const hinted: IngredientDetail = {
  ...ingredient,
  allergenHints: {
    contains: ["wheat"],
    mayContain: ["tree_nuts"],
    checkLabel: ["soy"],
  },
  nutrition: {
    source: "usda_fdc",
    packageIngredients:
      "WATER, APPLE CIDER VINEGAR, WHEAT FLOUR, SALT, SPICES, NATURAL FLAVOR",
    sourceId: "2",
    description: "Peanut butter, smooth",
    updatedAt: new Date(),
    per100g: {
      water: 1.2,
      fat: 51,
      protein: 22,
      sugars: 10,
      starch: 8,
      fiber: 5,
      salt: 1.1,
      other: 1,
      totalCarbohydrate: 22,
      sodiumMg: 430,
      saturatedFat: 10,
      calories: 598,
      transFat: 0,
      cholesterolMg: 0,
      addedSugars: null,
      vitaminDMcg: null,
      calciumMg: 49,
      ironMg: 1.7,
      potassiumMg: 560,
    },
  },
}

const linked: IngredientDetail = {
  ...ingredient,
  nutrition: {
    source: "usda_fdc",
    packageIngredients: "",
    sourceId: "1",
    description: "Peanut butter, smooth",
    updatedAt: new Date(),
    per100g: {
      water: 1.2,
      fat: 51,
      protein: 22,
      sugars: 10,
      starch: 8,
      fiber: 5,
      salt: 1.1,
      other: 1,
      totalCarbohydrate: 22,
      sodiumMg: 430,
      saturatedFat: 10,
      calories: 598,
      transFat: 0,
      cholesterolMg: 0,
      addedSugars: null,
      vitaminDMcg: null,
      calciumMg: 49,
      ironMg: 1.7,
      potassiumMg: 560,
    },
  },
}

const pressed = (group: HTMLElement) =>
  [...group.querySelectorAll('button[aria-pressed="true"]')].map(
    (chip) => chip.textContent
  )

beforeEach(() => {
  vi.clearAllMocks()
  saveRef.current = null
  window.localStorage.clear()
  replaceIngredientAllergens.mockResolvedValue({ ok: true })
  updateIngredientNutritionSettings.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe("ingredient nutrition panel", () => {
  it("presses the catalog defaults and sends the full override list on a toggle", async () => {
    render(<IngredientNutritionPanel ingredient={ingredient} />)

    const contains = screen.getByRole("group", { name: "Contains" })
    const mayContain = screen.getByRole("group", { name: "May contain" })
    expect(pressed(contains)).toEqual(["Egg", "Peanut"])
    expect(pressed(mayContain)).toEqual(["Milk"])

    fireEvent.click(
      [...contains.querySelectorAll("button")].find(
        (chip) => chip.textContent === "Wheat"
      ) as Element
    )
    expect(pressed(contains)).toEqual(["Egg", "Peanut", "Wheat"])
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenCalledWith(ingredient.id, [
        { key: "milk", status: "mayContain" },
        { key: "egg", status: "contains" },
        { key: "peanut", status: "contains" },
        { key: "wheat", status: "contains" },
      ])
    )
    expect(setSaveState).toHaveBeenCalledWith("saving")
    await waitFor(() => expect(setSaveState).toHaveBeenCalledWith("saved"))
    expect(refresh).toHaveBeenCalled()
  })

  it("states does not contain when a catalog tag is deselected, and moves a tag between rows", async () => {
    render(<IngredientNutritionPanel ingredient={ingredient} />)
    const contains = screen.getByRole("group", { name: "Contains" })
    const mayContain = screen.getByRole("group", { name: "May contain" })

    fireEvent.click(
      [...contains.querySelectorAll("button")].find(
        (chip) => chip.textContent === "Peanut"
      ) as Element
    )
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenLastCalledWith(
        ingredient.id,
        [
          { key: "milk", status: "mayContain" },
          { key: "egg", status: "contains" },
          { key: "peanut", status: "doesNotContain" },
        ]
      )
    )

    fireEvent.click(
      [...mayContain.querySelectorAll("button")].find(
        (chip) => chip.textContent === "Egg"
      ) as Element
    )
    expect(pressed(contains)).toEqual([])
    expect(pressed(mayContain)).toEqual(["Milk", "Egg"])
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenLastCalledWith(
        ingredient.id,
        [
          { key: "milk", status: "mayContain" },
          { key: "egg", status: "mayContain" },
          { key: "peanut", status: "doesNotContain" },
        ]
      )
    )
  })

  it("saves the label name, not food and added sugars on their own", async () => {
    render(<IngredientNutritionPanel ingredient={ingredient} />)

    const name = screen.getByLabelText("Name on label")
    fireEvent.blur(name)
    expect(updateIngredientNutritionSettings).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: "Roasted peanuts" } })
    fireEvent.blur(name)
    await waitFor(() =>
      expect(updateIngredientNutritionSettings).toHaveBeenCalledWith(
        ingredient.id,
        {
          labelName: "Roasted peanuts",
          nonEdible: false,
          sugarsAreAdded: false,
        }
      )
    )

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Not food (packaging, equipment)" })
    )
    await waitFor(() =>
      expect(updateIngredientNutritionSettings).toHaveBeenCalledWith(
        ingredient.id,
        { labelName: "Roasted peanuts", nonEdible: true, sugarsAreAdded: false }
      )
    )

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Count its sugars as added sugars (sugar, honey, syrups)",
      })
    )
    await waitFor(() =>
      expect(updateIngredientNutritionSettings).toHaveBeenCalledWith(
        ingredient.id,
        { labelName: "Roasted peanuts", nonEdible: true, sugarsAreAdded: true }
      )
    )
  })

  it("puts both settings back when two writes in their domain fail", async () => {
    const answers: ((result: unknown) => void)[] = []
    updateIngredientNutritionSettings.mockImplementation(
      () => new Promise((resolve) => answers.push(resolve))
    )
    render(<IngredientNutritionPanel ingredient={ingredient} />)
    const notFood = screen.getByRole("checkbox", {
      name: "Not food (packaging, equipment)",
    })
    const sugars = screen.getByRole("checkbox", {
      name: "Count its sugars as added sugars (sugar, honey, syrups)",
    })

    fireEvent.click(notFood)
    await waitFor(() => expect(answers).toHaveLength(1))
    fireEvent.click(sugars)
    await act(async () => answers[0]({ error: "Could not save." }))
    await waitFor(() => expect(answers).toHaveLength(2))
    await act(async () => answers[1]({ error: "Could not save." }))

    // Neither reached the server, so neither stays on screen.
    await waitFor(() =>
      expect(notFood.getAttribute("aria-checked")).toBe("false")
    )
    expect(sugars.getAttribute("aria-checked")).toBe("false")
  })

  it("puts both allergen rows and the hints back when two writes fail", async () => {
    const answers: ((result: unknown) => void)[] = []
    replaceIngredientAllergens.mockImplementation(
      () => new Promise((resolve) => answers.push(resolve))
    )
    render(<IngredientNutritionPanel ingredient={hinted} />)
    const contains = screen.getByRole("group", { name: "Contains" })

    fireEvent.click(
      [...contains.querySelectorAll("button")].find(
        (chip) => chip.textContent === "Wheat"
      ) as Element
    )
    await waitFor(() => expect(answers).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: "Not in mine: Soy" }))
    await act(async () => answers[0]({ error: "Could not save." }))
    await waitFor(() => expect(answers).toHaveLength(2))
    await act(async () => answers[1]({ error: "Could not save." }))

    await waitFor(() =>
      expect(pressed(screen.getByRole("group", { name: "Contains" }))).toEqual([
        "Egg",
        "Peanut",
      ])
    )
    expect(screen.queryByRole("button", { name: "Confirm Soy" })).not.toBeNull()
  })

  it("reverts and toasts when a save fails", async () => {
    replaceIngredientAllergens.mockResolvedValue({ error: "Could not save." })
    render(<IngredientNutritionPanel ingredient={ingredient} />)
    const contains = screen.getByRole("group", { name: "Contains" })

    fireEvent.click(
      [...contains.querySelectorAll("button")].find(
        (chip) => chip.textContent === "Wheat"
      ) as Element
    )
    expect(pressed(contains)).toEqual(["Egg", "Peanut", "Wheat"])
    await waitFor(() => expect(pressed(contains)).toEqual(["Egg", "Peanut"]))
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Could not save.",
      type: "error",
    })
    expect(setSaveState).toHaveBeenCalledWith("error")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("confirms a package hint into Contains and drops it from the hints", async () => {
    render(<IngredientNutritionPanel ingredient={hinted} />)

    expect(screen.getByText("From the package label")).not.toBeNull()
    expect(
      screen.getByText(
        "Suggestions, not facts. Confirm what your brand's label says."
      )
    ).not.toBeNull()
    expect(
      screen.getByRole("group", { name: "May contain, from the package label" })
    ).not.toBeNull()
    expect(
      screen.getByRole("group", {
        name: "Depends on the brand. Check the label for:",
      })
    ).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Confirm Wheat" }))
    // The hint goes at once, and the tag lands in Contains.
    expect(screen.queryByRole("button", { name: "Confirm Wheat" })).toBeNull()
    expect(pressed(screen.getByRole("group", { name: "Contains" }))).toEqual([
      "Egg",
      "Peanut",
      "Wheat",
    ])
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenCalledWith(ingredient.id, [
        { key: "milk", status: "mayContain" },
        { key: "egg", status: "contains" },
        { key: "peanut", status: "contains" },
        { key: "wheat", status: "contains" },
      ])
    )
    expect(refresh).toHaveBeenCalled()
  })

  it("confirms a may contain hint into the May contain row", async () => {
    render(<IngredientNutritionPanel ingredient={hinted} />)

    fireEvent.click(screen.getByRole("button", { name: "Confirm Tree nuts" }))
    expect(pressed(screen.getByRole("group", { name: "May contain" }))).toEqual(
      ["Milk", "Tree nuts"]
    )
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenCalledWith(ingredient.id, [
        { key: "milk", status: "mayContain" },
        { key: "egg", status: "contains" },
        { key: "tree_nuts", status: "mayContain" },
        { key: "peanut", status: "contains" },
      ])
    )
  })

  it("dismisses a hint as does not contain, and puts it back when the save fails", async () => {
    render(<IngredientNutritionPanel ingredient={hinted} />)

    fireEvent.click(screen.getByRole("button", { name: "Not in mine: Soy" }))
    expect(screen.queryByRole("button", { name: "Confirm Soy" })).toBeNull()
    await waitFor(() =>
      expect(replaceIngredientAllergens).toHaveBeenCalledWith(ingredient.id, [
        { key: "milk", status: "mayContain" },
        { key: "egg", status: "contains" },
        { key: "peanut", status: "contains" },
        { key: "soy", status: "doesNotContain" },
      ])
    )

    replaceIngredientAllergens.mockResolvedValue({ error: "Could not save." })
    fireEvent.click(screen.getByRole("button", { name: "Not in mine: Wheat" }))
    expect(screen.queryByRole("button", { name: "Confirm Wheat" })).toBeNull()
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Confirm Wheat" })
      ).not.toBeNull()
    )
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Could not save.",
      type: "error",
    })
  })

  it("says Draft while a label name is typed, and the header's Save flushes it", async () => {
    render(<IngredientNutritionPanel ingredient={ingredient} />)

    fireEvent.change(screen.getByLabelText("Name on label"), {
      target: { value: "Roasted peanuts" },
    })
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(true))
    expect(updateIngredientNutritionSettings).not.toHaveBeenCalled()

    await act(async () => {
      await saveRef.current?.()
    })
    expect(updateIngredientNutritionSettings).toHaveBeenCalledWith(
      ingredient.id,
      { labelName: "Roasted peanuts", nonEdible: false, sugarsAreAdded: false }
    )
    await waitFor(() => expect(setDirty).toHaveBeenLastCalledWith(false))
  })

  it("sends one allergen write at a time and the latest selection last", async () => {
    const answers: ((result: unknown) => void)[] = []
    replaceIngredientAllergens.mockImplementation(
      () => new Promise((resolve) => answers.push(resolve))
    )
    render(<IngredientNutritionPanel ingredient={ingredient} />)
    const contains = screen.getByRole("group", { name: "Contains" })
    const chip = (label: string) =>
      [...contains.querySelectorAll("button")].find(
        (one) => one.textContent === label
      ) as Element

    fireEvent.click(chip("Wheat"))
    fireEvent.click(chip("Soy"))
    // The second toggle waits for the first, and the screen shows both.
    expect(replaceIngredientAllergens).toHaveBeenCalledTimes(1)
    expect(pressed(contains)).toContain("Wheat")
    expect(pressed(contains)).toContain("Soy")

    await act(async () => answers[0]({ ok: true }))
    expect(replaceIngredientAllergens).toHaveBeenCalledTimes(2)
    expect(replaceIngredientAllergens).toHaveBeenLastCalledWith(ingredient.id, [
      { key: "milk", status: "mayContain" },
      { key: "egg", status: "contains" },
      { key: "peanut", status: "contains" },
      { key: "wheat", status: "contains" },
      { key: "soy", status: "contains" },
    ])
    await act(async () => answers[1]({ ok: true }))
    expect(pressed(contains)).toContain("Soy")
  })

  it("puts the tags back when the write throws, and saves again on a retry", async () => {
    replaceIngredientAllergens.mockRejectedValue(
      new Error("Failed to find the Server Action")
    )
    render(<IngredientNutritionPanel ingredient={ingredient} />)
    const contains = screen.getByRole("group", { name: "Contains" })
    const chip = (label: string) =>
      [...contains.querySelectorAll("button")].find(
        (one) => one.textContent === label
      ) as Element

    fireEvent.click(chip("Wheat"))
    await waitFor(() => expect(pressed(contains)).toEqual(["Egg", "Peanut"]))
    expect(toastAdd).toHaveBeenCalledWith({
      title: expect.stringContaining("A new version was deployed"),
      type: "error",
    })
    expect(setSaveState).toHaveBeenLastCalledWith("error")

    replaceIngredientAllergens.mockResolvedValue({ ok: true })
    fireEvent.click(chip("Wheat"))
    await waitFor(() => expect(setSaveState).toHaveBeenLastCalledWith("saved"))
    expect(pressed(contains)).toEqual(["Egg", "Peanut", "Wheat"])
  })

  it("truncates the package label until Show all opens it", () => {
    const { unmount } = render(
      <IngredientNutritionPanel ingredient={ingredient} />
    )
    expect(screen.queryByText("Show all")).toBeNull()
    unmount()

    render(<IngredientNutritionPanel ingredient={hinted} />)
    const line = screen.getByText(/^Package label:/)
    expect(line.className).toContain("truncate")
    expect(line.textContent).toBe(
      "Package label: WATER, APPLE CIDER VINEGAR, WHEAT FLOUR, SALT, SPICES, NATURAL FLAVOR"
    )

    fireEvent.click(screen.getByText("Show all"))
    expect(screen.getByText(/^Package label:/).className).not.toContain(
      "truncate"
    )
    expect(screen.queryByText("Show all")).toBeNull()
  })

  it("asks for a link before it previews, then builds the preview per serving", () => {
    const { unmount } = render(
      <IngredientNutritionPanel ingredient={ingredient} />
    )
    expect(
      screen.getByText("Link nutrition data to see a preview.")
    ).not.toBeNull()
    expect(screen.queryByText("Nutrition Facts")).toBeNull()
    unmount()

    render(<IngredientNutritionPanel ingredient={linked} />)
    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    // 598 kcal per 100 g at the default 100 g serving rounds to 600.
    expect(screen.getByText("600")).not.toBeNull()
    expect(screen.getByText("Vitamin D").parentElement?.textContent).toBe(
      "Vitamin D at least 0mcg"
    )
    expect(
      screen.getByText(
        "Not every nutrient is known: Added sugars, Vitamin D. Link a fuller record or request a custom value."
      )
    ).not.toBeNull()

    fireEvent.change(screen.getByLabelText("Serving (g)"), {
      target: { value: "50" },
    })
    expect(screen.getByText("300")).not.toBeNull()
    expect(screen.getByText("Peanut butter")).not.toBeNull()
    expect(screen.getByText("Egg, Peanut")).not.toBeNull()
  })

  it("shows what a pending request asked for, stating only the lines it carried", () => {
    render(<IngredientNutritionPanel ingredient={pendingRequest} />)
    expect(screen.getByText("Request pending")).not.toBeNull()
    expect(screen.queryByText("Total fat")).toBeNull()

    fireEvent.click(screen.getByText("Show what was sent"))
    expect(
      screen.getByText("American Almond Almond Paste, 7 LB — sent per 14 g")
    ).not.toBeNull()
    expect(screen.getByText("Total fat").parentElement?.textContent).toBe(
      "Total fat11 g"
    )
    expect(screen.getByText("Calories").parentElement?.textContent).toBe(
      "Calories100 kcal"
    )
    expect(screen.queryByText("Dietary fiber")).toBeNull()
    expect(screen.getByText("Note: From the pack")).not.toBeNull()
  })
})
