// @vitest-environment jsdom

import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CategoryCombobox } from "@/components/recipes/category-combobox"

afterEach(cleanup)

/** The editor's own state, so the value survives the pick the way it does there. */
function Harness({ options }: { options: readonly string[] }) {
  const [value, setValue] = React.useState("")
  return (
    <CategoryCombobox value={value} onChange={setValue} options={options} />
  )
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Category" }))
}

describe("CategoryCombobox", () => {
  it("lists a category it just added, before the recipe has saved", () => {
    render(<Harness options={["Bread"]} />)

    open()
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search categories" }),
      {
        target: { value: "Pastry" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add “Pastry”" }))
    expect(
      screen.getByRole("button", { name: "Category" }).textContent
    ).toContain("Pastry")

    // The server prop still has not caught up, and the list carries it anyway.
    open()
    expect(screen.getByRole("button", { name: "Pastry" })).not.toBeNull()
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search categories" }),
      {
        target: { value: "Pastry" },
      }
    )
    expect(screen.queryByRole("button", { name: "Add “Pastry”" })).toBeNull()
  })

  it("keeps a saved category the option list does not carry", () => {
    render(
      <CategoryCombobox value="Fats" onChange={() => {}} options={["Bread"]} />
    )

    open()
    expect(screen.getByRole("button", { name: "Fats" })).not.toBeNull()
  })
})
