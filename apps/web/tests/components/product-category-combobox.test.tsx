// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProductCategoryCombobox } from "@/components/menu/product-category-combobox"

afterEach(cleanup)

function open(value = "") {
  const onChange = vi.fn()
  render(
    <ProductCategoryCombobox
      value={value}
      onChange={onChange}
      options={["Breads", "Pastry"]}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Category" }))
  return onChange
}

describe("the product category picker", () => {
  it("chooses a category the catalog already uses", () => {
    const onChange = open()

    fireEvent.click(screen.getByRole("button", { name: "Pastry" }))

    expect(onChange).toHaveBeenCalledWith("Pastry")
  })

  it("filters the list by what was typed", () => {
    open()

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search categories" }),
      {
        target: { value: "bre" },
      }
    )

    expect(screen.getByRole("button", { name: "Breads" })).not.toBeNull()
    expect(screen.queryByRole("button", { name: "Pastry" })).toBeNull()
  })

  it("adds a name the catalog does not carry yet", () => {
    const onChange = open()

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search categories" }),
      {
        target: { value: "Cakes" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add “Cakes”" }))

    expect(onChange).toHaveBeenCalledWith("Cakes")
  })
})
