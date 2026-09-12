// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * The list's Actions pill is where a comparison starts: the selection goes
 * to the compare page in the URL, and no selection opens the page empty for
 * recipes pasted from elsewhere.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  shareRecipes: vi.fn(),
  updateRecipeStatuses: vi.fn(),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

const go = vi.hoisted(() => vi.fn())
vi.mock("@/components/navigation-blocker", () => ({
  useGuardedNavigate: () => ({ go, pending: false }),
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
    publicId: "rcp_a",
    title: "Country loaf",
    code: "R1",
    kind: "recipe",
    status: "active",
    categoryId: null,
    category: "bread",
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

const ROWS = [
  recipe({}),
  recipe({ id: "rec-2", publicId: "rcp_b", title: "Brioche" }),
]

function selectRow(index: number) {
  fireEvent.click(screen.getAllByLabelText("Select row")[index])
}

async function compareItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }))
  return await screen.findByRole("menuitem", { name })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("comparing recipes from the list", () => {
  it("opens the empty compare page when nothing is selected", async () => {
    render(<RecipesTable rows={ROWS} currencyCode="USD" />)
    fireEvent.click(await compareItem("Compare recipes"))
    expect(go).toHaveBeenCalledWith("/recipes/compare")
  })

  it("sends the selection along in the URL", async () => {
    render(<RecipesTable rows={ROWS} currencyCode="USD" />)
    selectRow(0)
    selectRow(1)
    fireEvent.click(await compareItem("Compare 2 recipes"))
    expect(go).toHaveBeenCalledWith("/recipes/compare?r=rcp_a,rcp_b")
  })

  it("names one selected recipe in the singular", async () => {
    render(<RecipesTable rows={ROWS} currencyCode="USD" />)
    selectRow(1)
    fireEvent.click(await compareItem("Compare 1 recipe"))
    expect(go).toHaveBeenCalledWith("/recipes/compare?r=rcp_b")
  })

  it("refuses more columns than the page can show", async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      recipe({
        id: `rec-${index}`,
        publicId: `rcp_${index}`,
        title: `R${index}`,
      })
    )
    render(<RecipesTable rows={many} currencyCode="USD" />)
    for (let index = 0; index < 7; index += 1) selectRow(index)
    const item = await compareItem("Compare up to 6")
    expect(item.hasAttribute("data-disabled")).toBe(true)
    expect(go).not.toHaveBeenCalled()
  })
})
