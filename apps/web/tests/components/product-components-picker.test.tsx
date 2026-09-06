// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

// components-dialog reaches a server action module the picker never calls.
vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))

import { ProductComponentPicker } from "@/components/menu/product-components-picker"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
} from "@/lib/backend/types"

afterEach(cleanup)

const bread: MenuRecipeOption = {
  id: "rec-1",
  publicId: "rcp_1",
  title: "Bread",
  kind: "recipe",
  category: "Bakery",
  menuPriceCents: 450,
  ingredientCents: 120,
  suffix: "/pc",
  batchMeasures: [],
  servingAmount: null,
  servingUnit: null,
}

const butter: MenuIngredientOption = {
  id: "ing-1",
  name: "Butter",
  purchaseUnit: "kg",
  nonEdible: false,
}

const products: MenuProductOption[] = [
  { id: "prd-1", publicId: "prd_box", name: "Box A", componentProductIds: [] },
  { id: "prd-2", publicId: "prd_kit", name: "Box B", componentProductIds: [] },
]

const takeoutBox: MenuIngredientOption = {
  id: "ing-2",
  name: "Takeout box",
  purchaseUnit: "each",
  nonEdible: true,
}

function open(
  onPick: (target: unknown) => void,
  blocked: ReadonlySet<string> = new Set(),
  query = "Box"
) {
  render(
    <ProductComponentPicker
      recipes={[bread]}
      ingredients={[butter, takeoutBox]}
      products={products}
      selected={new Set()}
      blockedProductIds={blocked}
      onPick={onPick}
    />
  )
  const field = screen.getByLabelText("Add product component")
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value: query } })
}

describe("the product component picker", () => {
  it("badges a product and a supply, and searches every kind", () => {
    open(vi.fn())

    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      ["Takeout boxSupply", "Box AProduct", "Box BProduct"]
    )
    expect(
      (screen.getByLabelText("Add product component") as HTMLInputElement)
        .placeholder
    ).toBe("Search a recipe, product, ingredient or supply")
  })

  it("leaves out a blocked product", () => {
    open(vi.fn(), new Set(["prd-1"]))

    expect(screen.queryByRole("option", { name: /Box A/ })).toBeNull()
    expect(screen.getByRole("option", { name: /Box B/ })).toBeTruthy()
  })

  it("picks a product target", () => {
    const onPick = vi.fn()
    open(onPick)

    fireEvent.click(screen.getByRole("option", { name: /Box A/ }))

    expect(onPick).toHaveBeenCalledWith({
      kind: "product",
      id: "prd-1",
      name: "Box A",
      publicId: "prd_box",
    })
  })
})
