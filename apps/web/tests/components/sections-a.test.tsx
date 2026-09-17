// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

import { SECTIONS_A } from "@/app/design/sections-a"

// The page demo links through GuardedLink, which reads the app router that no
// component test mounts.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/design",
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(cleanup)

const IDS = [
  "page",
  "section",
  "heading",
  "text",
  "paragraph",
  "link",
  "unordered-list",
  "ordered-list",
  "button",
  "button-group",
  "press-button",
  "clickable",
  "badge",
  "banner",
  "chip",
  "clickable-chip",
  "spinner",
  "tooltip",
  "avatar",
  "thumbnail",
  "image",
  "icon",
  "text-field",
  "text-area",
  "number-field",
  "money-field",
]

const TITLES = [
  "Page",
  "Section",
  "Heading",
  "Text",
  "Paragraph",
  "Link",
  "Unordered list",
  "Ordered list",
  "Button",
  "Button group",
  "Press button",
  "Clickable",
  "Badge",
  "Banner",
  "Chip",
  "Clickable chip",
  "Spinner",
  "Tooltip",
  "Avatar",
  "Thumbnail",
  "Image",
  "Icon",
  "Text field",
  "Text area",
  "Number field",
  "Money field",
]

describe("visual guide sections 1 to 26", () => {
  it("lists the ids and the titles in the owner's order", () => {
    expect(SECTIONS_A.map((section) => section.id)).toEqual(IDS)
    expect(SECTIONS_A.map((section) => section.title)).toEqual(TITLES)
  })

  it.each(SECTIONS_A.map((section) => [section.id, section.Demo] as const))(
    "renders the %s demo",
    (_id, Demo) => {
      const { container } = render(<Demo />)
      expect(container.firstChild).not.toBeNull()
    }
  )

  it("lays the button out as a matrix of variants by size", () => {
    const buttonSection = SECTIONS_A.find((section) => section.id === "button")
    const Demo = buttonSection!.Demo
    const { container } = render(<Demo />)

    const table = container.querySelector("table")
    expect(table).not.toBeNull()
    const columns = within(table!)
      .getAllByRole("columnheader")
      .map((header) => header.textContent)
    expect(columns).toContain("outline")
    expect(columns).toContain("destructive")
    const rows = within(table!)
      .getAllByRole("rowheader")
      .map((header) => header.textContent)
    expect(rows).toEqual(["xs", "sm", "default", "lg"])
  })

  it("keeps the page demo off the article's landmarks and headings", () => {
    const pageSection = SECTIONS_A.find((section) => section.id === "page")
    const Demo = pageSection!.Demo
    const { container } = render(<Demo />)

    expect(container.querySelector("main")).not.toBeNull()
    expect(screen.queryByRole("main")).toBeNull()
    expect(screen.getByRole("region", { name: "Page example" })).toBeTruthy()
    expect(
      screen.getByRole("heading", { level: 3, name: "Butter croissant" })
    ).toBeTruthy()
  })
})
