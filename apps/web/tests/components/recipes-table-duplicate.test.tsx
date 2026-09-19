// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { duplicateRecipe, go, toastAdd } = vi.hoisted(() => ({
  duplicateRecipe: vi.fn(),
  go: vi.fn(),
  toastAdd: vi.fn<(options: object) => string>(() => "toast-1"),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/app/(app)/recipes/actions", () => ({
  deleteRecipe: vi.fn(),
  deleteRecipes: vi.fn(),
  duplicateRecipe,
  updateRecipeStatuses: vi.fn(),
}))
vi.mock("@/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast")>()),
  useToast: () => ({ add: toastAdd, update: vi.fn(), close: vi.fn() }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children?: React.ReactNode
  }) => <a href={href}>{children}</a>,
  useGuardedNavigate: () => ({ go, pending: false }),
  useNavigationBlocker: () => ({
    allowNavigation: vi.fn(),
    confirmNavigation: vi.fn(),
  }),
}))

import { RecipesTable } from "@/components/recipes/recipes-table"
import type { RecipeHealth } from "@/lib/recipe/health"

const recipe = {
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
} as RecipeHealth

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("duplicating a recipe from its row", () => {
  it("asks the backend for the copy, then opens it", async () => {
    duplicateRecipe.mockResolvedValue({
      id: "rec-2",
      publicId: "rcp_copy",
      code: "R2",
      editVersion: 0,
    })
    render(<RecipesTable rows={[recipe]} currencyCode="USD" />)

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Focaccia, sea salt" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }))

    await waitFor(() =>
      expect(go).toHaveBeenCalledWith("/recipes/rcp_copy/recipe")
    )
    expect(duplicateRecipe).toHaveBeenCalledWith("rec-1")
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Duplicated Focaccia, sea salt",
    })
  })

  it("stays on the list and says why when the copy is refused", async () => {
    duplicateRecipe.mockResolvedValue({ error: "Recipe not found." })
    render(<RecipesTable rows={[recipe]} currencyCode="USD" />)

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Focaccia, sea salt" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }))

    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith({
        title: "Recipe not found.",
        type: "error",
      })
    )
    expect(go).not.toHaveBeenCalled()
  })
})
