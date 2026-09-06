// @vitest-environment jsdom

import * as React from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  activateCatalogIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import { IngredientCombobox } from "@/components/ingredients/ingredient-combobox"

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))

afterEach(cleanup)

const INGREDIENTS = [
  { id: "ing-butter", name: "Butter", nonEdible: false },
  { id: "ing-carrots", name: "Carrots", nonEdible: false },
  { id: "ing-boxes", name: "Takeout boxes", nonEdible: true },
]

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Match ingredient" }))
}

function search(value: string) {
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search ingredients" }),
    {
      target: { value },
    }
  )
}

describe("IngredientCombobox", () => {
  it("filters the pantry as the reviewer types", () => {
    render(
      <IngredientCombobox
        id="line-1"
        value=""
        onChange={() => {}}
        ingredients={INGREDIENTS}
      />
    )

    open()
    expect(screen.getByRole("button", { name: "Butter" })).not.toBeNull()
    search("box")
    expect(screen.queryByRole("button", { name: "Butter" })).toBeNull()
    expect(screen.getByRole("button", { name: "Takeout boxes" })).not.toBeNull()
  })

  it("groups supplies apart from food", () => {
    render(
      <IngredientCombobox
        id="line-1"
        value=""
        onChange={() => {}}
        ingredients={INGREDIENTS}
      />
    )

    open()
    expect(screen.getByText("Ingredients")).not.toBeNull()
    expect(screen.getByText("Supplies")).not.toBeNull()
    search("carrot")
    // Only food matched, so the Supplies heading goes with its rows.
    expect(screen.queryByText("Supplies")).toBeNull()
  })

  it("keeps the create row first and reports it as an empty id", () => {
    const onChange = vi.fn()
    render(
      <IngredientCombobox
        id="line-1"
        value="ing-butter"
        onChange={onChange}
        ingredients={INGREDIENTS}
        createLabel="Create “Ghee”"
      />
    )

    open()
    search("butter")
    const rows = screen.getAllByRole("button")
    expect(rows[1].textContent).toContain("Create “Ghee”")
    fireEvent.click(screen.getByRole("button", { name: "Create “Ghee”" }))
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("picks an ingredient by id and names it on the trigger", () => {
    const onChange = vi.fn()
    render(
      <IngredientCombobox
        id="line-1"
        value="ing-boxes"
        onChange={onChange}
        ingredients={INGREDIENTS}
      />
    )

    expect(
      screen.getByRole("button", { name: "Match ingredient" }).textContent
    ).toContain("Takeout boxes")
    open()
    fireEvent.click(screen.getByRole("button", { name: "Carrots" }))
    expect(onChange).toHaveBeenCalledWith("ing-carrots")
  })

  it("takes the first match on Enter", () => {
    const onChange = vi.fn()
    render(
      <IngredientCombobox
        id="line-1"
        value=""
        onChange={onChange}
        ingredients={INGREDIENTS}
      />
    )

    open()
    search("carr")
    fireEvent.keyDown(
      screen.getByRole("searchbox", { name: "Search ingredients" }),
      { key: "Enter" }
    )
    expect(onChange).toHaveBeenCalledWith("ing-carrots")
  })

  it("offers the catalog for a name the pantry lacks and adopts the pick", async () => {
    vi.mocked(searchCatalogIngredients).mockResolvedValueOnce({
      items: [
        { id: "cat-1", name: "Chicken foot", preparations: [], aliases: [] },
      ],
    })
    vi.mocked(activateCatalogIngredient).mockResolvedValueOnce({
      id: "ing-feet",
      name: "Chicken foot",
      created: true,
      preparations: [],
    })
    const onChange = vi.fn()
    const onCreated = vi.fn()
    render(
      <IngredientCombobox
        id="line-1"
        value=""
        onChange={onChange}
        ingredients={INGREDIENTS}
        onCreated={onCreated}
      />
    )

    open()
    search("chick")
    const row = await waitFor(() =>
      screen.getByRole("button", { name: /Chicken foot/ })
    )
    expect(row.textContent).toContain("Catalog")
    fireEvent.click(row)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("ing-feet"))
    expect(activateCatalogIngredient).toHaveBeenCalledWith("cat-1")
    expect(onCreated).toHaveBeenCalledWith({
      id: "ing-feet",
      name: "Chicken foot",
      nonEdible: false,
    })
  })
})
