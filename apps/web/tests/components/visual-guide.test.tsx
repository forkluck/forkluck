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
]

describe("visual guide registry", () => {
  it("holds the sections in the owner's order", () => {
    expect(SECTIONS.map((section) => section.id)).toEqual(EXPECTED_IDS)
  })

  it("carries the owner's headings", () => {
    expect(SECTIONS.map((section) => section.title)).toEqual(EXPECTED_TITLES)
  })

  it("ends the contents rail with the tokens table", () => {
    expect(CONTENTS).toHaveLength(SECTIONS.length + 1)
    expect(CONTENTS.at(-1)).toEqual({
      id: "design-tokens",
      title: "Design tokens",
    })
  })
})

describe("visual guide page", () => {
  it("gives every contents link a heading to land on", () => {
    const { container } = render(<DesignGuidePage />)
    const links = [...container.querySelectorAll(".toc a")].map((link) =>
      link.getAttribute("href")
    )
    expect(links).toEqual(CONTENTS.map(({ id }) => `#${id}`))

    const headings = [...container.querySelectorAll("h2[id]")]
    expect(headings.map((heading) => heading.id)).toEqual(
      CONTENTS.map(({ id }) => id)
    )
    expect(headings.map((heading) => heading.textContent)).toEqual(
      CONTENTS.map(({ title }) => title)
    )
  })

  it("puts one captioned pane under every section", () => {
    const { container } = render(<DesignGuidePage />)
    const panes = [...container.querySelectorAll("[data-demo]")]
    expect(panes.map((pane) => pane.getAttribute("data-demo"))).toEqual(
      EXPECTED_IDS
    )
    for (const pane of panes) {
      expect(
        pane.querySelector(".pane-cap")?.textContent,
        pane.getAttribute("data-demo") ?? ""
      ).toBe("Forkluck")
    }
  })

  it("owns the only top-level heading and adds no second landmark", () => {
    render(<DesignGuidePage />)
    // The Page demo's title is an `h1` element carrying aria-level 3, so the
    // article keeps the one heading the document is titled by.
    const headings = screen.getAllByRole("heading", { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe(
      "Forkluck visual guide: every component, rendered live"
    )
    expect(screen.queryByRole("main")).toBeNull()
  })
})
