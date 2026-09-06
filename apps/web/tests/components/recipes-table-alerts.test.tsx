// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  shareRecipes: vi.fn(),
  updateRecipeStatus: vi.fn(),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children?: React.ReactNode
  }) => <a href={href}>{children}</a>,
  useNavigationBlocker: () => ({
    allowNavigation: vi.fn(),
    confirmNavigation: vi.fn(),
  }),
}))

import { RecipesTable } from "@/components/recipes/recipes-table"
import type { RecipeHealth } from "@/lib/recipe/health"

const recipe = (partial: Partial<RecipeHealth>): RecipeHealth =>
  ({
    id: "rec-1",
    publicId: "abc123",
    title: "Focaccia, sea salt",
    code: "R1",
    kind: "recipe",
    status: "active",
    categoryId: null,
    category: "pastry",
    updatedAt: new Date("2026-02-03T10:00:00Z"),
    ingredientCents: 125,
    menuPriceCents: 400,
    foodCost: 0.3125,
    overTarget: false,
    suffix: "/pc",
    issues: [],
    labor: null,
    ...partial,
  }) as RecipeHealth

afterEach(cleanup)

describe("recipes table alerts column", () => {
  it("flags a recipe whose lines are off, naming each gap", () => {
    render(
      <RecipesTable
        rows={[
          recipe({
            id: "rec-2",
            title: "Mooncake",
            issues: ["stray words", "unresolved item"],
          }),
          recipe({}),
        ]}
        currencyCode="USD"
      />
    )
    const flags = screen.getAllByRole("button", {
      name: "Lines not linked to an ingredient or recipe, Lines with extra words that aren’t a saved preparation",
    })
    expect(flags).toHaveLength(1)
  })

  it("keeps the flag off recipes that are whole", () => {
    render(
      <RecipesTable
        rows={[recipe({}), recipe({ id: "rec-2", issues: ["no portion"] })]}
        currencyCode="USD"
      />
    )
    expect(screen.queryByText("Lines", { exact: false })).toBeNull()
    // The unpriced flag left the cost column for the alerts column.
    render(
      <RecipesTable
        rows={[recipe({ id: "rec-3", issues: ["2 unpriced"] })]}
        currencyCode="USD"
      />
    )
    expect(
      screen.getByRole("button", { name: "2 ingredients without a price" })
    ).toBeTruthy()
  })
})
