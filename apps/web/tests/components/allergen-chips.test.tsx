// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AllergenChips } from "@/components/nutrition/allergen-chips"
import { EU_DECLARED, US_DECLARED } from "@/lib/nutrition/allergens"

afterEach(cleanup)

/** The tag chips in a row, ignoring the More tags disclosure. */
function chips(group: HTMLElement) {
  return within(group)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") !== null)
}

describe("allergen chips", () => {
  it("presses the selected tags in their row and reports a toggle", () => {
    const onToggle = vi.fn()
    render(
      <AllergenChips
        region="us"
        value={{ contains: ["milk"], mayContain: ["egg"] }}
        onToggle={onToggle}
      />
    )

    const contains = screen.getByRole("group", { name: "Contains" })
    const mayContain = screen.getByRole("group", { name: "May contain" })
    expect(chips(contains).length).toBe(US_DECLARED.size)
    expect(
      contains.querySelector('button[aria-pressed="true"]')?.textContent
    ).toBe("Milk")
    expect(
      mayContain.querySelector('button[aria-pressed="true"]')?.textContent
    ).toBe("Egg")

    fireEvent.click(
      mayContain.querySelector('button[aria-pressed="false"]') as Element
    )
    expect(onToggle).toHaveBeenCalledWith("milk", "mayContain")
  })

  it("keeps the rest of the tags behind More tags", () => {
    render(
      <AllergenChips
        region="us"
        value={{ contains: [], mayContain: [] }}
        onToggle={vi.fn()}
      />
    )

    const contains = screen.getByRole("group", { name: "Contains" })
    expect(within(contains).queryByText("Mustard")).toBeNull()

    fireEvent.click(within(contains).getByRole("button", { name: /More tags/ }))

    expect(chips(contains).length).toBe(19)
    expect(within(contains).getByText("Mustard")).not.toBeNull()
    // The other row stays as it was.
    const mayContain = screen.getByRole("group", { name: "May contain" })
    expect(chips(mayContain).length).toBe(US_DECLARED.size)
  })

  it("never hides a tag that is already set", () => {
    render(
      <AllergenChips
        region="us"
        value={{ contains: ["mustard"], mayContain: [] }}
        onToggle={vi.fn()}
      />
    )

    const contains = screen.getByRole("group", { name: "Contains" })
    expect(chips(contains).length).toBe(US_DECLARED.size + 1)
    expect(
      contains.querySelector('button[aria-pressed="true"]')?.textContent
    ).toBe("Mustard")
  })

  it("leads with the EU list where the kitchen labels for the EU", () => {
    render(
      <AllergenChips
        region="eu"
        value={{ contains: [], mayContain: [] }}
        onToggle={vi.fn()}
      />
    )

    const contains = screen.getByRole("group", { name: "Contains" })
    expect(chips(contains).length).toBe(EU_DECLARED.size)
    expect(within(contains).getByText("Mustard")).not.toBeNull()
    expect(within(contains).queryByText("Allium")).toBeNull()
  })

  it("reads only the selected tags, and says when there are none", () => {
    render(
      <AllergenChips
        region="us"
        value={{ contains: ["tree_nuts", "milk"], mayContain: [] }}
        readOnly
      />
    )

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Milk")).not.toBeNull()
    expect(screen.getByText("Tree nuts")).not.toBeNull()
    expect(screen.queryByText("Egg")).toBeNull()
    expect(screen.getByText("None listed")).not.toBeNull()
  })
})
