// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

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
    overTarget: true,
    suffix: "/pc",
    issues: [],
    labor: null,
    ...partial,
  }) as RecipeHealth

/** The CSV the export handed to the browser. */
let downloaded = ""

function table(rows: RecipeHealth[]) {
  render(<RecipesTable rows={rows} currencyCode="USD" />)
}

afterEach(() => {
  cleanup()
  downloaded = ""
})

vi.stubGlobal("URL", {
  ...URL,
  createObjectURL: (blob: Blob) => {
    void blob.text().then((text) => {
      downloaded = text
    })
    return "blob:recipes"
  },
  revokeObjectURL: vi.fn(),
})

describe("exporting recipes to CSV", () => {
  it("shows the unit beside the normalized ingredient cost", () => {
    table([recipe({ ingredientCents: 793, suffix: "/L" })])

    expect(screen.getByText("$7.93/L")).toBeTruthy()
  })

  it("writes a header and one row for the selected recipe", async () => {
    table([recipe({}), recipe({ id: "rec-2", title: "Brioche" })])

    fireEvent.click(screen.getAllByLabelText("Select row")[0])
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export 1 recipe" })
    )

    await vi.waitFor(() => expect(downloaded).not.toBe(""))
    const [header, ...rows] = downloaded.split("\n")
    expect(header).toBe(
      "Title,Code,Category,Status,Cost per portion,Sell price,Food cost %,Updated"
    )
    expect(rows).toEqual([
      '"Focaccia, sea salt",R1,Pastry,active,1.25,4.00,31.3,2026-02-03',
    ])
  })

  it("leaves the money and the percent blank when nothing is costed", async () => {
    table([
      recipe({ ingredientCents: null, menuPriceCents: null, foodCost: null }),
    ])

    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export recipes" })
    )

    await vi.waitFor(() => expect(downloaded).not.toBe(""))
    expect(downloaded.split("\n")[1]).toBe(
      '"Focaccia, sea salt",R1,Pastry,active,,,,2026-02-03'
    )
  })
})
