// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { SECTIONS_B } from "@/app/design/sections-b"

afterEach(cleanup)

const EXPECTED_IDS = [
  "email-field",
  "password-field",
  "url-field",
  "search-field",
  "select",
  "date-field",
  "date-picker",
  "color-field",
  "color-picker",
  "drop-zone",
  "checkbox",
  "choice-list",
  "switch",
  "table",
  "divider",
  "box",
  "stack",
  "grid",
  "scroll-box",
  "query-container",
  "popover",
  "menu",
  "modal",
  "empty-state",
  "number",
]

describe("visual guide sections 27 to 51", () => {
  it("lists the ids in the page's order", () => {
    expect(SECTIONS_B.map((section) => section.id)).toEqual(EXPECTED_IDS)
  })

  it("gives every section a title and a description", () => {
    for (const section of SECTIONS_B) {
      expect(section.title.length, section.id).toBeGreaterThan(0)
      expect(typeof section.description, section.id).toBe("string")
    }
  })

  for (const section of SECTIONS_B) {
    it(`renders the ${section.id} demo`, () => {
      const { Demo } = section
      expect(() => render(<Demo />)).not.toThrow()
    })
  }

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
