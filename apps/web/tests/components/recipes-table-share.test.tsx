// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

const shareRecipes = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  shareRecipes,
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
    title: "Mooncake",
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

const ROWS = [recipe({}), recipe({ id: "rec-2", title: "Shortbread" })]

function table(rows: RecipeHealth[] = ROWS) {
  render(<RecipesTable rows={rows} currencyCode="USD" />)
}

function selectRow(index: number) {
  fireEvent.click(screen.getAllByLabelText("Select row")[index])
}

async function shareItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }))
  return await screen.findByRole("menuitem", { name })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("sharing recipes from the list", () => {
  it("names one selected recipe and several by the plural", async () => {
    table()

    selectRow(0)
    expect(
      (await shareItem("Share recipe")).hasAttribute("data-disabled")
    ).toBe(false)
    fireEvent.keyDown(document.body, { key: "Escape" })
    selectRow(1)

    expect(await shareItem("Share recipes")).toBeTruthy()
  })

  it("offers nothing to share until a row is selected", async () => {
    table()

    expect(
      (await shareItem("Share recipes")).hasAttribute("data-disabled")
    ).toBe(true)
  })

  it("refuses a selection holding a recipe someone else owns", async () => {
    table([
      ROWS[0],
      recipe({ id: "rec-2", title: "Loaf", permission: "editor" }),
    ])

    selectRow(0)
    selectRow(1)

    expect(
      (await shareItem("Share recipes")).hasAttribute("data-disabled")
    ).toBe(true)
  })

  it("opens the dialog on the selected titles and lets the selection go", async () => {
    shareRecipes.mockResolvedValue({ shared: 2, guest: null })
    table()

    selectRow(0)
    selectRow(1)
    fireEvent.click(await shareItem("Share recipes"))

    expect(screen.getByText("Mooncake and Shortbread")).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
      target: { value: "chef@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await vi.waitFor(() =>
      expect(shareRecipes).toHaveBeenCalledWith({
        recipeIds: ["rec-1", "rec-2"],
        email: "chef@example.com",
        role: "viewer",
      })
    )
    await vi.waitFor(() => expect(screen.queryByText("2 selected")).toBeNull())
  })
})
