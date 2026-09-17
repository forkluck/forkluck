// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

import { SECTIONS_B } from "@/app/design/sections-b"

afterEach(cleanup)

const EXPECTED_SECTIONS = [
  ["email-field", "Email field"],
  ["password-field", "Password field"],
  ["url-field", "URL field"],
  ["search-field", "Search field"],
  ["select", "Select"],
  ["date-field", "Date field"],
  ["date-picker", "Date picker"],
  ["color-field", "Color field"],
  ["color-picker", "Color picker"],
  ["drop-zone", "Drop zone"],
  ["checkbox", "Checkbox"],
  ["choice-list", "Choice list"],
  ["switch", "Switch"],
  ["table", "Table"],
  ["divider", "Divider"],
  ["box", "Box"],
  ["stack", "Stack"],
  ["grid", "Grid"],
  ["scroll-box", "Scroll box"],
  ["query-container", "Query container"],
  ["popover", "Popover"],
  ["menu", "Menu"],
  ["modal", "Modal"],
  ["empty-state", "Empty state"],
  ["number", "Number"],
]

describe("visual guide sections 27 to 51", () => {
  it("lists the ids and titles in the page's order", () => {
    expect(SECTIONS_B.map((section) => [section.id, section.title])).toEqual(
      EXPECTED_SECTIONS
    )
  })

  for (const section of SECTIONS_B) {
    it(`renders the ${section.id} demo`, () => {
      const { Demo } = section
      expect(() => render(<Demo />)).not.toThrow()
    })
  }

  it("lays the switch out as a matrix of sizes by states", () => {
    const section = SECTIONS_B.find((entry) => entry.id === "switch")
    if (!section) throw new Error("switch section is missing")
    const { Demo } = section
    render(<Demo />)
    const [matrix] = screen.getAllByRole("table")
    expect(
      within(matrix)
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
    ).toEqual(["sm", "default"])
    expect(
      within(matrix)
        .getAllByRole("rowheader")
        .map((header) => header.textContent)
    ).toEqual(["Off", "On", "Disabled"])
  })

  it("pins the date field to a fixed day", () => {
    const section = SECTIONS_B.find((entry) => entry.id === "date-field")
    if (!section) throw new Error("date-field section is missing")
    const { Demo } = section
    render(<Demo />)
    expect(screen.getByLabelText<HTMLInputElement>("Delivery date").value).toBe(
      "2026-09-16"
    )
  })
})
