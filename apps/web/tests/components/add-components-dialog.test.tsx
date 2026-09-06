// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

// components-dialog reaches a server action module this dialog never calls.
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))

import { AddComponentsDialog } from "@/components/menu/add-components-dialog"
import type { ProductComponentDraft } from "@/components/menu/product-components"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"

afterEach(cleanup)

const RECIPES: MenuRecipeOption[] = [
  {
    id: "rec-1",
    publicId: "rcp_1",
    title: "Croissant",
    kind: "recipe",
    category: "Pastry",
    menuPriceCents: 450,
    ingredientCents: 120,
    suffix: "/pc",
    batchMeasures: [{ amount: 20, unit: "kg" }],
    servingAmount: null,
    servingUnit: null,
  },
]

const INGREDIENTS: MenuIngredientOption[] = [
  { id: "ing-1", name: "Flour", purchaseUnit: "g", nonEdible: false },
  { id: "ing-2", name: "Butter", purchaseUnit: "kg", nonEdible: false },
  { id: "ing-3", name: "Takeout bag", purchaseUnit: "each", nonEdible: true },
]

const PRODUCTS: MenuProductOption[] = [
  { id: "prd-1", publicId: "prd_box", name: "Box A", componentProductIds: [] },
  { id: "prd-2", publicId: "prd_kit", name: "Box B", componentProductIds: [] },
]

function open({
  selected = new Set<string>(),
  blocked = new Set<string>(),
  remaining = 10,
}: {
  selected?: ReadonlySet<string>
  blocked?: ReadonlySet<string>
  remaining?: number
} = {}) {
  const onAdd = vi.fn()
  render(
    <AddComponentsDialog
      open
      onOpenChange={vi.fn()}
      recipes={RECIPES}
      ingredients={INGREDIENTS}
      products={PRODUCTS}
      selected={selected}
      blockedProductIds={blocked}
      remaining={remaining}
      onAdd={onAdd}
    />
  )
  return onAdd
}

const tab = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }))

describe("the add components dialog", () => {
  it("splits the targets across the four tabs", () => {
    open()

    expect(screen.getByRole("checkbox", { name: "Flour" })).toBeDefined()
    expect(screen.queryByRole("checkbox", { name: "Takeout bag" })).toBeNull()

    tab("Supplies")
    expect(screen.getByRole("checkbox", { name: "Takeout bag" })).toBeDefined()
    expect(screen.queryByRole("checkbox", { name: "Flour" })).toBeNull()

    tab("Recipes")
    expect(screen.getByRole("checkbox", { name: "Croissant" })).toBeDefined()

    tab("Products")
    expect(screen.getByRole("checkbox", { name: "Box A" })).toBeDefined()
  })

  it("filters the active tab by name", () => {
    open()

    fireEvent.change(screen.getByRole("searchbox", { name: /Search/ }), {
      target: { value: "but" },
    })

    expect(screen.getByRole("checkbox", { name: "Butter" })).toBeDefined()
    expect(screen.queryByRole("checkbox", { name: "Flour" })).toBeNull()
  })

  it("adds every checked row at once", () => {
    const onAdd = open()

    fireEvent.click(screen.getByRole("checkbox", { name: "Flour" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Butter" }))
    expect(screen.getByText("2 selected")).toBeDefined()

    fireEvent.change(
      screen.getByRole("textbox", { name: "Quantity for Flour" }),
      {
        target: { value: "250" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    const drafts = onAdd.mock.calls[0]![0] as ProductComponentDraft[]
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({
      ingredientId: "ing-1",
      ingredientName: "Flour",
      quantity: 250,
      unit: "g",
      nonEdible: false,
    })
    expect(drafts[1]).toMatchObject({
      ingredientId: "ing-2",
      quantity: 1,
      unit: "kg",
    })
  })

  it("says what a batch of a recipe makes and starts a recipe row in batches", () => {
    const onAdd = open()
    tab("Recipes")
    expect(screen.getByText("Recipe · 20 kg/batch")).toBeDefined()

    fireEvent.click(screen.getByRole("checkbox", { name: "Croissant" }))
    const chip = screen.getByRole("button", { name: "Croissant unit" })
    expect(chip.textContent).toContain("batches")

    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    const drafts = onAdd.mock.calls[0]![0] as ProductComponentDraft[]
    expect(drafts[0]).toMatchObject({
      recipeId: "rec-1",
      quantity: 1,
      unit: "",
    })
  })

  it("keeps an already linked row checked and inert", () => {
    const onAdd = open({ selected: new Set(["ingredient:ing-1"]) })

    const box = screen.getByRole("checkbox", { name: "Flour" })
    expect(box.getAttribute("aria-checked")).toBe("true")
    expect(box.hasAttribute("data-disabled")).toBe(true)

    fireEvent.click(screen.getByText("Flour"))
    expect(screen.getByText("0 selected")).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")
    ).toBe(true)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("leaves out a blocked product", () => {
    open({ blocked: new Set(["prd-1"]) })
    tab("Products")

    expect(screen.queryByRole("checkbox", { name: "Box A" })).toBeNull()
    expect(screen.getByRole("checkbox", { name: "Box B" })).toBeDefined()
  })

  it("refuses more rows than the product can hold", () => {
    open({ remaining: 1 })

    fireEvent.click(screen.getByRole("checkbox", { name: "Flour" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Butter" }))

    expect(screen.getByText("At most 1 more can be added.")).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")
    ).toBe(true)
  })
})
