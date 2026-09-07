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
import type { Nutrients } from "@/lib/backend/types"
import {
  NutritionLabel,
  NutritionLabelCard,
} from "@/components/nutrition/nutrition-label"

let labelRegion: "us" | "eu" = "us"
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ labelRegion }),
}))

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

const per100g = nutrients({
  calories: 500,
  energyKj: 2092,
  fat: 16.8,
  saturatedFat: 5.5,
  sodiumMg: 292,
  totalCarbohydrate: 74.8,
  sugars: 25,
  protein: 10.4,
  salt: 0.73,
  vitaminDMcg: 4,
  calciumMg: 528,
  ironMg: 2.5,
  potassiumMg: 470,
})
const perServing = nutrients({
  calories: 250,
  energyKj: 1046,
  fat: 8.4,
  saturatedFat: 2.75,
  sodiumMg: 146,
  totalCarbohydrate: 37.4,
  sugars: 12.5,
  protein: 5.2,
  salt: 0.365,
  vitaminDMcg: 2,
  calciumMg: 264,
  ironMg: 1.25,
  potassiumMg: 235,
})

const base = {
  serving: { amount: 1, unit: "slice", grams: 50 },
  servings: 12,
  perServing,
  per100g,
  statement: [
    { name: "Butter", grams: 100, allergens: ["milk"] },
    { name: "Flour", grams: 200, allergens: [] },
    { name: "Almonds", grams: 40, allergens: ["tree_nuts"] },
  ],
  allergens: {
    contains: ["milk", "tree_nuts", "allium"],
    mayContain: ["sulphites"],
  },
}

const ready = { ready: true, missing: [] as never[] }

/** The ingredient names the list emphasises. */
function emphasised(): string[] {
  return Array.from(document.querySelectorAll("strong")).map(
    (node) => node.textContent ?? ""
  )
}

beforeEach(() => {
  labelRegion = "us"
  window.localStorage.clear()
})

afterEach(cleanup)

describe("NutritionLabel", () => {
  it("renders the US panel with the statement, the CONTAINS line and the footer", () => {
    render(<NutritionLabel format="us" {...base} />)

    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    expect(screen.getByText("12 servings per container")).not.toBeNull()
    expect(screen.getByText("1 slice (50 g)")).not.toBeNull()
    expect(screen.getByText("250")).not.toBeNull()
    expect(screen.getByText("Total Fat").parentElement?.textContent).toBe(
      "Total Fat 8g"
    )
    expect(screen.getByText("Ingredients:").parentElement?.textContent).toBe(
      "Ingredients: butter, flour, almonds"
    )
    expect(screen.getByText("Milk, Tree nuts (almonds)")).not.toBeNull()
    // The CONTAINS line is the US declaration; the list carries no emphasis.
    expect(emphasised()).toEqual([])
    expect(
      screen.getByText("Kitchen tags not on a US label: Allium, Sulphites")
    ).not.toBeNull()
    expect(
      screen.queryByText(
        "A real label names the nut, fish or shellfish species."
      )
    ).toBeNull()
    expect(
      screen.getByText(
        "It is a preview, not a verified label. Accuracy on a package is the seller’s responsibility, so have the numbers verified before you print one."
      )
    ).not.toBeNull()
  })

  it("renders the EU table per 100 g and per serving", () => {
    render(<NutritionLabel format="eu" {...base} />)

    expect(screen.getByText("Per 100 g")).not.toBeNull()
    expect(screen.getByText("One serving is 1 slice (50 g).")).not.toBeNull()
    expect(screen.getByText("2092 kJ")).not.toBeNull()
    expect(screen.getByText("1046 kJ")).not.toBeNull()
    expect(screen.getByText("0.73 g")).not.toBeNull()
    expect(screen.queryByText("Nutrition Facts")).toBeNull()
  })

  it("declares by emphasis alone on an EU label", () => {
    render(<NutritionLabel format="eu" {...base} />)

    expect(screen.queryByText(/^Contains:/)).toBeNull()
    expect(emphasised()).toEqual(["butter", "almonds"])
    expect(screen.getByText("Sulphites")).not.toBeNull()
    expect(
      screen.getByText("Kitchen tags not on an EU label: Allium")
    ).not.toBeNull()
  })

  it("names the species only when the statement could not", () => {
    render(
      <NutritionLabel
        format="us"
        {...base}
        statement={[{ name: "Stock", grams: 100, allergens: ["fish"] }]}
        allergens={{ contains: ["fish"], mayContain: [] }}
      />
    )
    expect(screen.getByText("Fish (stock)")).not.toBeNull()
    expect(
      screen.queryByText(
        "A real label names the nut, fish or shellfish species."
      )
    ).toBeNull()

    cleanup()
    render(
      <NutritionLabel
        format="us"
        {...base}
        statement={[{ name: "Stock", grams: 100, allergens: [] }]}
        allergens={{ contains: ["fish"], mayContain: [] }}
      />
    )
    expect(screen.getByText("Fish")).not.toBeNull()
    expect(
      screen.getByText("A real label names the nut, fish or shellfish species.")
    ).not.toBeNull()
  })

  it("prints an incomplete value plainly, as a label would", () => {
    render(
      <NutritionLabel
        format="us"
        {...base}
        perServing={nutrients({ calories: 250, vitaminDMcg: 2 }, [
          "vitaminDMcg",
        ])}
      />
    )
    expect(screen.getByText("Vitamin D").parentElement?.textContent).toBe(
      "Vitamin D 2mcg"
    )
    expect(screen.queryByText(/at least/)).toBeNull()
  })

  it("writes one serving per container in the singular", () => {
    render(<NutritionLabel format="us" {...base} servings={1} />)
    expect(screen.getByText("1 serving per container")).not.toBeNull()
  })
})

describe("NutritionLabelCard", () => {
  it("shows only the checklist while a batch issue stands", () => {
    render(
      <NutritionLabelCard
        {...base}
        perServing={null}
        per100g={null}
        readiness={{ us: ready, eu: ready }}
        blockers={["Give the recipe a total yield on the Recipe tab."]}
        servingBlockers={[]}
      />
    )
    expect(screen.getByText("Label preview")).not.toBeNull()
    expect(screen.getByText("Before the preview can build")).not.toBeNull()
    expect(
      screen.getByText("Give the recipe a total yield on the Recipe tab.")
    ).not.toBeNull()
    expect(screen.queryByText("Nutrition Facts")).toBeNull()
    expect(screen.queryByRole("button", { name: "Print preview" })).toBeNull()
  })

  it("remembers the format in localStorage and reads it back on mount", async () => {
    const { unmount } = render(
      <NutritionLabelCard
        {...base}
        readiness={{ us: ready, eu: ready }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "EU" }))
    expect(screen.getByText("Per 100 g")).not.toBeNull()
    expect(window.localStorage.getItem("nutrition-label-format")).toBe("eu")
    unmount()

    render(
      <NutritionLabelCard
        {...base}
        readiness={{ us: ready, eu: ready }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    await waitFor(() => expect(screen.getByText("Per 100 g")).not.toBeNull())
  })

  it("starts on the business label region when nothing is stored", async () => {
    labelRegion = "eu"
    render(
      <NutritionLabelCard
        {...base}
        readiness={{ us: ready, eu: ready }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    expect(screen.getByText("Per 100 g")).not.toBeNull()
    await waitFor(() => expect(screen.getByText("Per 100 g")).not.toBeNull())
    expect(screen.queryByText("Nutrition Facts")).toBeNull()
  })

  it("honours a stored choice over the business label region", async () => {
    labelRegion = "eu"
    window.localStorage.setItem("nutrition-label-format", "us")
    render(
      <NutritionLabelCard
        {...base}
        readiness={{ us: ready, eu: ready }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    await waitFor(() =>
      expect(screen.getByText("Nutrition Facts")).not.toBeNull()
    )
  })

  it("names the missing nutrients for the format that is not ready", () => {
    render(
      <NutritionLabelCard
        {...base}
        readiness={{
          us: { ready: false, missing: ["vitaminDMcg", "potassiumMg"] },
          eu: ready,
        }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    expect(
      screen.getByText(
        "The label counts only what the linked records report, so these are understated: Vitamin D, Potassium. Link a fuller record or request a custom value."
      )
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "EU" }))
    expect(screen.queryByText(/so these are understated/)).toBeNull()
  })

  it("prints from the Print preview button", () => {
    const print = vi.fn()
    vi.stubGlobal("print", print)
    render(
      <NutritionLabelCard
        {...base}
        readiness={{ us: ready, eu: ready }}
        blockers={[]}
        servingBlockers={[]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Print preview" }))
    expect(print).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
