// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

// The selection bar's "…" menu refreshes through the router after a delete.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))
// The name cell links out through the blocker; the table needs no router.
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...rest
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import {
  MenuItemsTable,
  type MenuItemPatch,
  type MenuItemState,
  type MenuLinkTarget,
} from "@/components/menus/menu-items-table"
import { ToastProvider } from "@/components/ui/toast"
import type { MenuProductOption, MenuRecipeOption } from "@/lib/backend/types"
import { deriveRows } from "@/lib/menu/engineering"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const croissant: MenuRecipeOption = {
  id: "rec-1",
  publicId: "rcp_1",
  title: "Croissant",
  kind: "recipe",
  category: "Pastry",
  menuPriceCents: 450,
  ingredientCents: 120,
  suffix: "/pc",
  batchMeasures: [],
  servingAmount: null,
  servingUnit: null,
}

const latte: MenuProductOption = {
  id: "prod-1",
  publicId: "prd_latte",
  name: "Latte",
  componentProductIds: [],
}

/** A recipe-linked row, the worksheet's plainest kind. */
function item(partial: Partial<MenuItemState> = {}): MenuItemState {
  return {
    key: "row-1",
    id: null,
    name: "Croissant",
    category: "Pastry",
    sellPriceCents: 500,
    qtySold: 10,
    recipeId: "rec-1",
    recipePublicId: "rcp_1",
    productId: null,
    productPublicId: null,
    foodCostCents: 120,
    sourceSellPriceCents: 500,
    sourceQtySold: null,
    original: null,
    ...partial,
  }
}

function productItem(partial: Partial<MenuItemState> = {}): MenuItemState {
  return item({
    key: "row-p",
    name: "Latte",
    category: "Drinks",
    sellPriceCents: 450,
    qtySold: 20,
    recipeId: null,
    recipePublicId: null,
    productId: "prod-1",
    productPublicId: "prd_latte",
    foodCostCents: 90,
    sourceSellPriceCents: 450,
    sourceQtySold: 20,
    ...partial,
  })
}

function unlinked(partial: Partial<MenuItemState> = {}): MenuItemState {
  return item({
    key: "row-u",
    name: "",
    category: "",
    sellPriceCents: 0,
    qtySold: 0,
    recipeId: null,
    recipePublicId: null,
    foodCostCents: null,
    sourceSellPriceCents: null,
    ...partial,
  })
}

function Harness({
  initial,
  recipes = [croissant],
  products = [latte],
  onCreateRecipe = () => undefined,
  onCreateProduct = () => undefined,
}: {
  initial: MenuItemState[]
  recipes?: MenuRecipeOption[]
  products?: MenuProductOption[]
  onCreateRecipe?: (key: string, name: string) => void
  onCreateProduct?: (key: string, name: string) => void
}) {
  const [items, setItems] = React.useState(initial)
  const next = React.useRef(0)
  const patch = (key: string, change: MenuItemPatch) =>
    setItems((current) =>
      current.map((one) =>
        one.key === key
          ? { ...one, ...(typeof change === "function" ? change(one) : change) }
          : one
      )
    )
  // What the editor fills a picked link in with, minus the product fetch.
  const link = (key: string, target: MenuLinkTarget) =>
    patch(key, (one) =>
      target.kind === "recipe"
        ? {
            recipeId: target.id,
            recipePublicId: target.recipe.publicId,
            name: target.recipe.title,
            category: target.recipe.category ?? "",
            foodCostCents: target.recipe.ingredientCents,
            sourceSellPriceCents: target.recipe.menuPriceCents,
            sellPriceCents:
              one.sellPriceCents || (target.recipe.menuPriceCents ?? 0),
          }
        : {
            productId: target.id,
            productPublicId: target.publicId,
            name: target.name,
          }
    )
  const { rows: derived } = deriveRows(
    items.map((one) => ({
      sellPriceCents: one.sellPriceCents,
      qtySold: one.qtySold,
      foodCostCents: one.foodCostCents,
    }))
  )
  return (
    <ToastProvider>
      <MenuItemsTable
        items={items}
        derived={derived}
        recipes={recipes}
        products={products}
        currencyCode="USD"
        onPatch={patch}
        onLinkTarget={link}
        onCreateRecipe={onCreateRecipe}
        onCreateProduct={onCreateProduct}
        onAdd={(partial) => {
          next.current += 1
          const key = `added-${next.current}`
          setItems((current) => [...current, unlinked({ key, ...partial })])
          return key
        }}
        onRemove={(key) =>
          setItems((current) => current.filter((one) => one.key !== key))
        }
      />
      <output data-testid="rows">
        {items
          .map(
            (one) =>
              `${one.name}/${one.category}/${one.sellPriceCents}/${one.qtySold}/${one.recipeId ?? "-"}/${one.productId ?? "-"}`
          )
          .join("|")}
      </output>
    </ToastProvider>
  )
}

describe("the worksheet's typed cells", () => {
  it("moves the revenue cell when the price changes", () => {
    render(<Harness initial={[item()]} />)
    expect(screen.getByText("$50.00")).toBeTruthy()

    const price = screen.getByLabelText("Sell price") as HTMLInputElement
    fireEvent.focus(price)
    fireEvent.change(price, { target: { value: "6.00" } })
    fireEvent.blur(price)

    expect(screen.getByTestId("rows").textContent).toBe(
      "Croissant/Pastry/600/10/rec-1/-"
    )
    expect(screen.getByText("$60.00")).toBeTruthy()
  })

  it("reverts a price it cannot read", () => {
    render(<Harness initial={[item()]} />)
    const price = screen.getByLabelText("Sell price") as HTMLInputElement
    fireEvent.focus(price)
    fireEvent.change(price, { target: { value: "six dollars" } })
    fireEvent.blur(price)

    expect(
      (screen.getByLabelText("Sell price") as HTMLInputElement).value
    ).toBe("5.00")
  })

  it("reads a blank quantity on a recipe row as nothing sold", () => {
    render(<Harness initial={[item()]} />)
    const qty = screen.getByLabelText("Qty sold") as HTMLInputElement
    fireEvent.focus(qty)
    fireEvent.change(qty, { target: { value: "" } })
    fireEvent.blur(qty)

    expect(screen.getByTestId("rows").textContent).toBe(
      "Croissant/Pastry/500/0/rec-1/-"
    )
  })
})

describe("reading through the link", () => {
  it("links each name to its recipe or product page, with its kind", () => {
    render(<Harness initial={[item(), productItem()]} />)

    expect(
      (
        screen.getByRole("link", { name: "Croissant" }) as HTMLAnchorElement
      ).getAttribute("href")
    ).toBe("/recipes/rcp_1/recipe")
    expect(
      (
        screen.getByRole("link", { name: "Latte" }) as HTMLAnchorElement
      ).getAttribute("href")
    ).toBe("/products/prd_latte")
    expect(screen.getByText("Recipe")).toBeTruthy()
    expect(screen.getByText("Product")).toBeTruthy()
  })

  it("starts without the menu mix and class columns", () => {
    render(<Harness initial={[item()]} />)

    expect(screen.queryByText("Menu mix %")).toBeNull()
    expect(screen.queryByText("Class")).toBeNull()
    expect(screen.getByText("Food cost")).toBeTruthy()
  })

  it("shows the category read-only", () => {
    render(<Harness initial={[item()]} />)

    expect(screen.getByText("Pastry")).toBeTruthy()
    expect(screen.queryByLabelText("Category")).toBeNull()
  })

  it("flags a linked row the source cannot cost", () => {
    render(
      <Harness
        initial={[item({ foodCostCents: null }), unlinked({ key: "row-2" })]}
      />
    )

    expect(screen.getAllByLabelText("Not costed yet")).toHaveLength(1)
  })

  it("reads a product row's quantity from sales, not a field", () => {
    render(<Harness initial={[productItem()]} />)

    expect(screen.queryByLabelText("Qty sold")).toBeNull()
    expect(screen.getByText("20")).toBeTruthy()
  })

  it("dashes a product row with no sales in the period", () => {
    render(
      <Harness initial={[productItem({ qtySold: 0, sourceQtySold: 0 })]} />
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
    expect(screen.queryByText("0")).toBeNull()
  })
})

describe("the sell price flag", () => {
  it("says what the product charges when the row differs", () => {
    render(<Harness initial={[productItem({ sellPriceCents: 500 })]} />)

    expect(screen.getByLabelText("Product price is $4.50")).toBeTruthy()
  })

  it("says when the source has no price at all", () => {
    render(<Harness initial={[item({ sourceSellPriceCents: null })]} />)

    expect(screen.getByLabelText("No price on the recipe")).toBeTruthy()
  })

  it("stays quiet while the row matches the source", () => {
    render(<Harness initial={[item()]} />)

    expect(screen.queryByLabelText(/price is|No price/)).toBeNull()
  })
})

describe("linking a row", () => {
  it("links a picked recipe and fills its figures", () => {
    render(<Harness initial={[unlinked()]} />)

    const field = screen.getByLabelText("Item name")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Croissant" } })
    fireEvent.click(screen.getByRole("option", { name: /Croissant/ }))

    expect(screen.getByTestId("rows").textContent).toBe(
      "Croissant/Pastry/450/0/rec-1/-"
    )
    expect(screen.getByRole("link", { name: "Croissant" })).toBeTruthy()
  })

  it("links a picked product", () => {
    render(<Harness initial={[unlinked()]} />)

    const field = screen.getByLabelText("Item name")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Latte" } })
    fireEvent.click(screen.getByRole("option", { name: /Latte/ }))

    expect(screen.getByTestId("rows").textContent).toBe("Latte//0/0/-/prod-1")
  })

  it("keeps a link another row holds out of the picker", () => {
    render(<Harness initial={[item(), unlinked({ key: "row-2" })]} />)

    const field = screen.getByLabelText("Item name")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Croissant" } })

    expect(screen.queryByRole("option")).toBeNull()
  })

  it("offers to add a recipe or a product when nothing matches", () => {
    const created: string[] = []
    render(
      <Harness
        initial={[unlinked()]}
        onCreateRecipe={(key, name) => created.push(`recipe:${key}:${name}`)}
        onCreateProduct={(key, name) => created.push(`product:${key}:${name}`)}
      />
    )

    const field = screen.getByLabelText("Item name")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Soup of the day" } })
    fireEvent.click(
      screen.getByRole("button", { name: "Add product “Soup of the day”" })
    )
    fireEvent.change(field, { target: { value: "Soup of the day" } })
    fireEvent.click(
      screen.getByRole("button", { name: "Add recipe “Soup of the day”" })
    )

    expect(created).toEqual([
      "product:row-u:Soup of the day",
      "recipe:row-u:Soup of the day",
    ])
  })

  it("keeps a typed name that links to nothing, flagged in amber", () => {
    render(<Harness initial={[unlinked()]} />)

    const field = screen.getByLabelText("Item name")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Daily special" } })
    fireEvent.blur(field)

    expect(screen.getByTestId("rows").textContent).toBe(
      "Daily special//0/0/-/-"
    )
    expect(
      screen.getByLabelText("Not linked: pick a recipe or a product")
    ).toBeTruthy()
    // Uncosted and uncategorized, and with no price to disagree with.
    expect(screen.queryByLabelText(/price is|No price/)).toBeNull()
  })

  it("reopens the suggestions from the amber flag", () => {
    render(<Harness initial={[unlinked({ name: "Croissant" })]} />)

    fireEvent.click(
      screen.getByLabelText("Not linked: pick a recipe or a product")
    )
    fireEvent.focus(screen.getByLabelText("Item name"))

    expect(screen.getByRole("option", { name: /Croissant/ })).toBeTruthy()
  })

  it("returns a row to the picker from Change link, keeping its figures", async () => {
    render(<Harness initial={[item()]} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Croissant" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Change link" })
    )

    expect(screen.getByLabelText("Item name")).toBeTruthy()
    expect(screen.getByTestId("rows").textContent).toBe("Croissant//500/10/-/-")
  })

  it("appends an unlinked row with the empty field focused from + Add", () => {
    render(<Harness initial={[]} />)

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))

    const field = screen.getByLabelText("Item name")
    expect(document.activeElement).toBe(field)
  })

  it("removes a row from its kebab", async () => {
    render(
      <Harness
        initial={[
          item(),
          item({ key: "row-2", name: "Tart", recipeId: "rec-2" }),
        ]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Actions for Tart" }))
    const remove = await screen.findByRole("menuitem", { name: "Remove" })
    fireEvent.click(remove)

    expect(screen.getByTestId("rows").textContent).toBe(
      "Croissant/Pastry/500/10/rec-1/-"
    )
  })
})

describe("the quick-add field", () => {
  it("adds a named row for text that matches nothing", () => {
    render(<Harness initial={[]} />)

    const field = screen.getByLabelText("Quick add item")
    fireEvent.change(field, { target: { value: "Daily special" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(screen.getByTestId("rows").textContent).toBe(
      "Daily special//0/0/-/-"
    )
    expect((field as HTMLInputElement).value).toBe("")
  })

  it("adds a linked row from a picked suggestion", () => {
    render(<Harness initial={[]} />)

    const field = screen.getByLabelText("Quick add item")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Croissant" } })
    fireEvent.click(screen.getByRole("option", { name: /Croissant/ }))

    expect(screen.getByTestId("rows").textContent).toBe(
      "Croissant/Pastry/450/0/rec-1/-"
    )
  })

  it("offers to add a recipe or a product for a name nothing matches", () => {
    const created: string[] = []
    render(
      <Harness
        initial={[]}
        onCreateRecipe={(key, name) => created.push(`recipe:${key}:${name}`)}
        onCreateProduct={(key, name) => created.push(`product:${key}:${name}`)}
      />
    )

    const field = screen.getByLabelText("Quick add item")
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: "Soup of the day" } })
    fireEvent.click(
      screen.getByRole("button", { name: "Add recipe “Soup of the day”" })
    )

    expect(created).toEqual(["recipe:added-1:Soup of the day"])
    expect(screen.getByTestId("rows").textContent).toBe(
      "Soup of the day//0/0/-/-"
    )
  })
})

describe("selecting rows", () => {
  const three = [
    item(),
    item({ key: "row-2", name: "Tart", recipeId: "rec-2" }),
    item({ key: "row-3", name: "Scone", recipeId: "rec-3" }),
  ]

  it("shows no bulk bar until something is checked", () => {
    render(<Harness initial={three} />)

    expect(screen.queryByText("1 selected")).toBeNull()
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
  })

  it("removes every checked row at once", async () => {
    render(<Harness initial={three} />)

    fireEvent.click(screen.getByLabelText("Select Croissant"))
    fireEvent.click(screen.getByLabelText("Select Scone"))
    expect(screen.getByText("2 selected")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete items" })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Delete items" }))

    await waitFor(() => {
      expect(screen.getByTestId("rows").textContent).toBe(
        "Tart/Pastry/500/10/rec-2/-"
      )
    })
    expect(screen.queryByText("2 selected")).toBeNull()
  })

  it("checks every row from the header, then clears", () => {
    render(<Harness initial={three} />)
    const all = screen.getByLabelText("Select every row")

    fireEvent.click(all)
    expect(screen.getByText("3 selected")).toBeTruthy()

    fireEvent.click(all)
    expect(screen.queryByText("3 selected")).toBeNull()
  })

  it("shows the header box as partial when only some rows are checked", () => {
    render(<Harness initial={three} />)

    const all = screen.getByLabelText("Select every row")
    fireEvent.click(screen.getByLabelText("Select Tart"))
    expect(all.dataset.indeterminate).toBeDefined()

    fireEvent.click(all)
    expect(all.dataset.indeterminate).toBeUndefined()
  })
})

describe("adopting the source price", () => {
  it("offers Use $4.50 on the drift flag and patches the row", async () => {
    render(<Harness initial={[item({ sourceSellPriceCents: 450 })]} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Recipe price is $4.50" })
    )
    fireEvent.click(await screen.findByRole("button", { name: "Use $4.50" }))

    expect(screen.getByTestId("rows").textContent).toContain("/450/")
  })

  it("adopts every checked row's source price from the selection menu", async () => {
    render(
      <Harness
        initial={[
          item({ sourceSellPriceCents: 450 }),
          item({ key: "row-2", name: "Tart", recipeId: "rec-2" }),
        ]}
      />
    )

    fireEvent.click(screen.getByLabelText("Select Croissant"))
    fireEvent.click(screen.getByLabelText("Select Tart"))
    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Use source prices" })
    )

    expect(screen.getByTestId("rows").textContent).toContain("/450/")
    expect(screen.queryByText("2 selected")).toBeNull()
  })
})
