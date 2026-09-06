// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/app/(app)/menu/actions", () => ({ priceMenuComponent: vi.fn() }))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} data-guarded-link="true" {...props}>
      {children}
    </a>
  ),
  useNavigationBlocker: () => ({ setIsBlocked: vi.fn() }),
}))

import {
  blockedComponentProducts,
  componentDrafts,
  componentSection,
  componentsPatch,
  MAX_COMPONENTS,
  ProductComponentsCard,
  validateComponents,
  type ProductComponentDraft,
} from "@/components/menu/product-components"
import type {
  MenuIngredientOption,
  MenuProductOption,
  MenuRecipeOption,
  ProductDetail,
} from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const COMPONENTS: ProductDetail["components"] = [
  {
    id: "55555555-5555-4555-8555-555555555555",
    recipeId: "33333333-3333-4333-8333-333333333333",
    recipePublicId: "rcp_croissant",
    recipeName: "Croissant",
    ingredientId: null,
    ingredientPublicId: null,
    ingredientName: null,
    productId: null,
    productPublicId: null,
    productName: null,
    quantity: 1,
    unit: "",
    position: 0,
    nonEdible: false,
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    ingredientId: "44444444-4444-4444-8444-444444444444",
    ingredientPublicId: "ing_flour",
    ingredientName: "Flour",
    productId: null,
    productPublicId: null,
    productName: null,
    quantity: 2,
    unit: " g ",
    position: 1,
    nonEdible: false,
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    ingredientId: "88888888-8888-4888-8888-888888888888",
    ingredientPublicId: "ing_box",
    ingredientName: "Pastry box",
    productId: null,
    productPublicId: null,
    productName: null,
    quantity: 1,
    unit: "each",
    position: 2,
    nonEdible: true,
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recipeId: null,
    recipePublicId: null,
    recipeName: null,
    ingredientId: null,
    ingredientPublicId: null,
    ingredientName: null,
    productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    productPublicId: "prd_box",
    productName: "Mooncake Box",
    quantity: 3,
    unit: "",
    position: 3,
    nonEdible: false,
  },
]

const ROWS = componentDrafts({ components: COMPONENTS } as ProductDetail)

const RECIPES: MenuRecipeOption[] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    publicId: "rcp_croissant",
    title: "Croissant",
    kind: "recipe",
    category: "Pastry",
    menuPriceCents: null,
    ingredientCents: 300,
    suffix: "per batch",
  },
]
const INGREDIENTS: MenuIngredientOption[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Flour",
    purchaseUnit: "g",
    nonEdible: false,
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    name: "Takeout bag",
    purchaseUnit: "each",
    nonEdible: true,
  },
]

const SELF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const PRODUCTS: MenuProductOption[] = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    publicId: "prd_box",
    name: "Mooncake Box",
    componentProductIds: [],
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    publicId: "prd_kit",
    name: "Gift Kit",
    componentProductIds: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
  },
  {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    publicId: "prd_tray",
    name: "Tea Tray",
    componentProductIds: [SELF_ID],
  },
  {
    id: SELF_ID,
    publicId: "prd_self",
    name: "Maple Tart",
    componentProductIds: [],
  },
]

function renderCard(overrides: { rows?: ProductComponentDraft[] } = {}) {
  const onChange = vi.fn()
  render(
    <ProductComponentsCard
      rows={overrides.rows ?? ROWS}
      recipes={RECIPES}
      ingredients={INGREDIENTS}
      products={PRODUCTS}
      selfProductId={SELF_ID}
      onChange={onChange}
    />
  )
  return onChange
}

describe("Product composition", () => {
  it("groups recipes and edible/non-edible ingredients into the right sections", () => {
    expect(
      componentSection({
        recipeId: "recipe",
        productId: null,
        nonEdible: false,
      })
    ).toBe("Recipes")
    expect(
      componentSection({ recipeId: null, productId: null, nonEdible: false })
    ).toBe("Ingredients")
    expect(
      componentSection({ recipeId: null, productId: null, nonEdible: true })
    ).toBe("Supplies")
    expect(
      componentSection({ recipeId: null, productId: "p", nonEdible: false })
    ).toBe("Products")

    renderCard()
    expect(screen.getByRole("heading", { name: "Recipes" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Ingredients" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Products" })).toBeDefined()
    expect(screen.getByRole("heading", { name: "Supplies" })).toBeDefined()
    expect(screen.getByText("Croissant")).toBeDefined()
    expect(screen.getByText("Flour")).toBeDefined()
    expect(screen.getByText("Pastry box")).toBeDefined()
    expect(screen.getByText("Supply")).toBeDefined()
    const recipeLink = screen.getByRole("link", { name: "Croissant" })
    expect(recipeLink.getAttribute("href")).toBe(
      "/recipes/rcp_croissant/recipe"
    )
    expect(recipeLink.getAttribute("data-guarded-link")).toBe("true")
  })

  it("hands the rows back without the removed one", () => {
    const onChange = renderCard()

    fireEvent.click(screen.getByRole("button", { name: "Actions for Flour" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }))

    expect(onChange).toHaveBeenCalledWith([ROWS[0], ROWS[2], ROWS[3]])
  })

  it("adds a non-edible ingredient into Supplies and uses vocabulary units", () => {
    const onChange = renderCard()

    expect(screen.queryByRole("button", { name: "Croissant unit" })).toBeNull()
    expect(screen.getByRole("button", { name: "Flour unit" })).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "+ Add component" }))
    fireEvent.click(screen.getByRole("button", { name: "Supplies" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Takeout bag" }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    const next = onChange.mock.calls[0]![0] as ProductComponentDraft[]
    expect(next).toHaveLength(5)
    expect(componentSection(next[4]!)).toBe("Supplies")
    expect(next[4]).toMatchObject({
      recipeId: null,
      ingredientId: INGREDIENTS[1]!.id,
      ingredientName: "Takeout bag",
      unit: "each",
      nonEdible: true,
    })
  })

  it("renders a product component as a linked row with no unit", () => {
    renderCard()

    const link = screen.getByRole("link", { name: "Mooncake Box" })
    expect(link.getAttribute("href")).toBe("/products/prd_box")
    expect(link.getAttribute("data-guarded-link")).toBe("true")
    expect(screen.getByText("Product")).toBeDefined()
    expect(
      screen.queryByRole("button", { name: "Mooncake Box unit" })
    ).toBeNull()
  })

  it("shows the form's message for this card", () => {
    render(
      <ProductComponentsCard
        rows={ROWS}
        recipes={RECIPES}
        ingredients={INGREDIENTS}
        products={PRODUCTS}
        selfProductId={SELF_ID}
        error="Each component needs a positive quantity."
        onChange={vi.fn()}
      />
    )

    expect(screen.getByRole("alert").textContent).toContain(
      "Each component needs a positive quantity."
    )
  })
})

describe("validateComponents", () => {
  it("passes saved rows", () => {
    expect(validateComponents(ROWS)).toEqual({})
    expect(validateComponents([])).toEqual({})
  })

  it("keys a bad quantity on the row that carries it", () => {
    const rows = ROWS.map((row) =>
      row.key === ROWS[1]!.key ? { ...row, quantity: Number.NaN } : row
    )
    expect(validateComponents(rows)).toEqual({
      [`component-quantity-${ROWS[1]!.key}`]:
        "Each component needs a positive quantity.",
    })
  })

  it("keys a bad unit on the row's unit control", () => {
    expect(validateComponents([{ ...ROWS[0]!, unit: "g" }])).toEqual({
      [`component-unit-${ROWS[0]!.key}`]:
        "Recipe components do not use a unit.",
    })
    expect(validateComponents([{ ...ROWS[1]!, unit: " " }])).toEqual({
      [`component-unit-${ROWS[1]!.key}`]: "Ingredient components need a unit.",
    })
  })

  it("keys the row-count and half-filled-row rules on the section", () => {
    const many = Array.from({ length: MAX_COMPONENTS + 1 }, (_, index) => ({
      ...ROWS[1]!,
      key: `row-${index}`,
    }))
    expect(validateComponents(many)).toEqual({
      "product-components": `Use at most ${MAX_COMPONENTS} components.`,
    })
    expect(
      validateComponents([{ ...ROWS[0]!, ingredientId: "ing", unit: "" }])
    ).toEqual({
      "product-components":
        "Each row needs exactly one recipe, product or ingredient.",
    })
  })
})

describe("blockedComponentProducts", () => {
  it("blocks the product itself and everything that already reaches it", () => {
    const blocked = blockedComponentProducts(SELF_ID, PRODUCTS)

    expect(blocked.has(SELF_ID)).toBe(true)
    // Tea Tray contains this product; Gift Kit contains Tea Tray.
    expect(blocked.has("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).toBe(true)
    expect(blocked.has("dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBe(true)
    expect(blocked.has("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(false)
  })
})

describe("validateComponents on product rows", () => {
  it("wants whole units and no unit", () => {
    expect(validateComponents([{ ...ROWS[3]!, quantity: 2.5 }])).toEqual({
      [`component-quantity-${ROWS[3]!.key}`]:
        "A product component needs a whole number of units.",
    })
    expect(validateComponents([{ ...ROWS[3]!, unit: "g" }])).toEqual({
      [`component-unit-${ROWS[3]!.key}`]:
        "Product components do not use a unit.",
    })
  })
})

describe("componentsPatch", () => {
  it("renumbers positions from the array order and trims units", () => {
    expect(componentsPatch([ROWS[1]!, ROWS[0]!])).toEqual([
      {
        recipeId: null,
        ingredientId: COMPONENTS[1]!.ingredientId,
        productId: null,
        quantity: 2,
        unit: "g",
        position: 0,
      },
      {
        recipeId: COMPONENTS[0]!.recipeId,
        ingredientId: null,
        productId: null,
        quantity: 1,
        unit: "",
        position: 1,
      },
    ])
  })

  it("emits the product target of a bundle row", () => {
    expect(componentsPatch([ROWS[3]!])).toEqual([
      {
        recipeId: null,
        ingredientId: null,
        productId: COMPONENTS[3]!.productId,
        quantity: 3,
        unit: "",
        position: 0,
      },
    ])
  })
})
