// @vitest-environment jsdom

import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { IngredientTagsCard } from "@/components/ingredients/ingredient-tags-card"

const options = [
  { id: "tag-1", name: "Bakery", count: 0 },
  { id: "tag-2", name: "Produce", count: 4 },
]

function TagsHarness() {
  const [tags, setTags] = React.useState<string[]>([])
  return (
    <IngredientTagsCard options={options} value={tags} onChange={setTags} />
  )
}

afterEach(cleanup)

describe("ingredient tags card", () => {
  it("selects and removes existing tenant tags", () => {
    render(<TagsHarness />)

    fireEvent.click(screen.getByRole("button", { name: "Add tags" }))
    expect(screen.getByText("Frequently used")).not.toBeNull()
    expect(screen.getByText("Other tags")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Produce" }))
    fireEvent.keyDown(screen.getByLabelText("Search or add tags"), {
      key: "Escape",
    })

    expect(screen.getByText("Produce")).not.toBeNull()
    expect(screen.getByRole("button", { name: "Add tags" }).textContent).toBe(
      ""
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove Produce" }))
    expect(screen.queryByRole("button", { name: "Remove Produce" })).toBeNull()
    expect(screen.getByRole("button", { name: "Add tags" })).not.toBeNull()
  })

  it("creates a tag in the draft and keeps persistence for Save", () => {
    render(<TagsHarness />)

    fireEvent.click(screen.getByRole("button", { name: "Add tags" }))
    fireEvent.change(screen.getByLabelText("Search or add tags"), {
      target: { value: "Dairy" },
    })
    expect(screen.getByText("0 results")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add “Dairy”" }))
    fireEvent.keyDown(screen.getByLabelText("Search or add tags"), {
      key: "Escape",
    })

    expect(screen.getByRole("button", { name: "Remove Dairy" })).not.toBeNull()
  })
})
