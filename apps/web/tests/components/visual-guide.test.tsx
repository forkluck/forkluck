// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import DesignGuidePage from "@/app/design/page"
import { CONTENTS, SECTIONS } from "@/app/design/demos"

// The page demo links through GuardedLink, which reads the app router that no
// component test mounts.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/design",
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(cleanup)

/**
 * The page renders every component the app has, so jsdom needs the two layout
 * APIs Base UI's positioned parts reach for. Mocking them here keeps every
 * demo in the render rather than skipping the ones that float.
 */
beforeAll(() => {
  const view = window as unknown as Record<string, unknown>
  view.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  view.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
})

const EXPECTED_IDS = [
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
  "type-scale",
  "radius",
  "control-heights",
]

const EXPECTED_TITLES = [
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
  "Email field",
  "Password field",
  "URL field",
  "Search field",
  "Select",
  "Date field",
  "Date picker",
  "Color field",
  "Color picker",
  "Drop zone",
  "Checkbox",
  "Choice list",
  "Switch",
  "Table",
  "Divider",
  "Box",
  "Stack",
  "Grid",
  "Scroll box",
  "Query container",
  "Popover",
  "Menu",
  "Modal",
  "Empty state",
  "Number",
  "Type scale",
  "Radius",
  "Control heights",
]

describe("component guide registry", () => {
  it("holds the sections in the owner's order", () => {
    expect(SECTIONS.map((section) => section.id)).toEqual(EXPECTED_IDS)
  })

  it("carries the owner's headings", () => {
    expect(SECTIONS.map((section) => section.title)).toEqual(EXPECTED_TITLES)
  })

  it("ends the contents rail with the tokens", () => {
    expect(CONTENTS).toHaveLength(SECTIONS.length + 1)
    expect(CONTENTS.at(-1)).toEqual({
      id: "design-tokens",
      title: "Design tokens",
    })
  })
})

describe("component guide page", () => {
  it("gives every contents link a heading to land on", () => {
    const { container } = render(<DesignGuidePage />)
    const sections = [...container.querySelectorAll("section[id]")]
    expect(sections.map((section) => section.id)).toEqual(
      CONTENTS.map(({ id }) => id)
    )
    // Every section names its component in an `h2`; demos below it drop to
    // `h3` so the section heading is the only `h2` inside.
    for (const [index, section] of sections.entries()) {
      const heading = section.querySelector("h2")
      expect(heading?.textContent, section.id).toBe(CONTENTS[index].title)
    }
    expect(container.querySelectorAll("h1")).toHaveLength(1)
    expect(container.querySelectorAll("h2")).toHaveLength(CONTENTS.length)
  })

  it("lists one contents link per entry", () => {
    const { container } = render(<DesignGuidePage />)
    const nav = container.querySelector('nav[aria-label="Contents"]')
    const links = [...(nav?.querySelectorAll("a") ?? [])].map((link) =>
      link.getAttribute("href")
    )
    expect(links).toEqual(CONTENTS.map(({ id }) => `#${id}`))
  })

  it("owns the only top-level heading and adds no second landmark", () => {
    render(<DesignGuidePage />)
    // The Page demo renders its title as an `h3`, so the guide keeps the one
    // heading the document is titled by.
    const headings = screen.getAllByRole("heading", { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe("Components")
    expect(screen.queryByRole("main")).toBeNull()
  })

  it("draws the sections on the bare page, with no article panes", () => {
    const { container } = render(<DesignGuidePage />)
    expect(container.querySelector(".pane")).toBeNull()
    expect(container.querySelector(".pane-cap")).toBeNull()
  })
})
