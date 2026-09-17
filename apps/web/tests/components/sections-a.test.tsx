// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

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

describe("visual guide sections 1 to 26", () => {
  it("lists the ids in the owner's order, each with a title and a description", () => {
    expect(SECTIONS_A.map((section) => section.id)).toEqual(IDS)
    for (const section of SECTIONS_A) {
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.description).toBeTruthy()
    }
  })

  it.each(SECTIONS_A.map((section) => [section.id, section.Demo] as const))(
    "renders the %s demo",
    (_id, Demo) => {
      const { container } = render(<Demo />)
      expect(container.firstChild).not.toBeNull()
    }
  )

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
