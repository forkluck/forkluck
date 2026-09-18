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

  it("lays the button out as the six variants, one size and two icon sizes", () => {
    const buttonSection = SECTIONS_A.find((section) => section.id === "button")
    const Demo = buttonSection!.Demo
    render(<Demo />)

    for (const label of [
      "Primary",
      "Secondary",
      "Tertiary",
      "Ghost",
      "Critical",
      "Critical text",
      "Disabled",
      "With icon",
      "Icon button",
      "Compact icon button",
      "Spinner",
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(
      screen.getByRole("button", { name: "More actions" }).className
    ).toContain("size-6")
    expect(screen.getByRole("button", { name: "Edit" }).className).toContain(
      "size-8"
    )
    expect(
      screen.getByRole("button", { name: "Saving" }).getAttribute("aria-busy")
    ).toBe("true")
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
