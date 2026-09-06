// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({
    currencyCode: "USD",
    measurementSystem: "imperial",
  }),
}))

vi.mock("@/components/ingredients/ingredient-chrome", () => ({
  useIngredientEdit: () => ({
    addPreparation: vi.fn(),
    editPreparation: vi.fn(),
    removePreparations: vi.fn(),
    purchaseUnit: null,
    savePurchaseUnit: vi.fn(),
  }),
  useIngredientFormBinding: () => ({
    saveRef: { current: null },
    actions: false,
    onDirtyChange: vi.fn(),
    onSaveStateChange: vi.fn(),
    purchaseUnit: null,
  }),
}))

vi.mock("@/components/ingredients/ingredient-form", () => ({
  IngredientForm: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...props
  }: {
    href: string
    children?: React.ReactNode
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  replaceIngredientAllergens: vi.fn(),
}))

import { IngredientPanel } from "@/components/ingredients/ingredient-panels"

const base = {
  id: "ing-1",
  name: "Butter",
  category: null,
  status: "active" as const,
  purchaseCostCents: 0,
  purchaseSize: null,
  purchaseUnit: null,
  yieldPercent: 100,
  priceSource: "user" as const,
  nutrition: null,
  nonEdible: false,
  sugarsAreAdded: false,
  nutritionLabelName: "",
  nutritionRequest: null,
  allergenHints: { contains: [], mayContain: [], checkLabel: [] },
  tags: [],
  preparations: [],
  priceHistory: [],
  usedInRecipes: [],
  usedInProducts: [],
}

const withUses = (usedInRecipes: unknown[]) =>
  ({ ...base, usedInRecipes }) as never

function usedIn() {
  return screen.getByRole("heading", { name: "Used in" }).closest("section")!
}

afterEach(cleanup)

describe("the Used in section", () => {
  it("lists each recipe with the amount it uses", () => {
    render(
      <IngredientPanel
        ingredient={withUses([
          {
            id: "r1",
            publicId: "rec_1",
            title: "Shortbread",
            status: "active",
            quantity: 2.75,
            unit: "cup",
          },
          {
            id: "r2",
            publicId: "rec_2",
            title: "Brown butter sauce",
            status: "active",
            quantity: null,
            unit: "",
          },
        ])}
        availableTags={[]}
      />
    )

    const section = within(usedIn())
    expect(section.getByText("2")).not.toBeNull()
    const shortbread = section.getByRole("link", { name: /Shortbread/ })
    expect(shortbread.getAttribute("href")).toBe("/recipes/rec_1/recipe")
    expect(within(shortbread).getByText("2 3/4 cup")).not.toBeNull()
    // A recipe that never stated an amount shows a title and nothing else.
    const sauce = section.getByRole("link", { name: /Brown butter sauce/ })
    expect(sauce.textContent).toBe("Brown butter sauce")
  })

  it("sinks archived recipes to the bottom and marks them", () => {
    render(
      <IngredientPanel
        ingredient={withUses([
          {
            id: "r1",
            publicId: "rec_1",
            title: "Retired cake",
            status: "archived",
            quantity: 1,
            unit: "lb",
          },
          {
            id: "r2",
            publicId: "rec_2",
            title: "Shortbread",
            status: "active",
            quantity: 1,
            unit: "lb",
          },
        ])}
        availableTags={[]}
      />
    )

    const section = within(usedIn())
    const titles = section
      .getAllByRole("link")
      .map((link) => link.textContent ?? "")
    expect(titles[0]).toContain("Shortbread")
    expect(titles[1]).toContain("Retired cake")
    expect(section.getByText("Archived")).not.toBeNull()
  })

  it("says so when no recipe uses the ingredient", () => {
    render(<IngredientPanel ingredient={withUses([])} availableTags={[]} />)

    const section = within(usedIn())
    expect(section.getByText("No recipe uses this yet.")).not.toBeNull()
    expect(section.queryAllByRole("link")).toHaveLength(0)
  })
})
