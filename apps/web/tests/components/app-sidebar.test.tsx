// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

let mockPathname = "/"

vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }))
vi.mock("@/components/app-search", () => ({ AppSearch: () => null }))
vi.mock("@/components/sidebar-account", () => ({ SidebarAccount: () => null }))
vi.mock("@/components/kitchen-switcher", () => ({
  KitchenSwitcher: () => <div data-testid="kitchen-switcher" />,
}))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...rest
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

window.matchMedia = ((query: string) => ({
  matches: true,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia

const { AppSidebar } = await import("@/components/app-sidebar")

afterEach(() => {
  cleanup()
  mockPathname = "/"
})

const USER = { id: "1", email: "chef@example.com", name: "Chef" }

const ROSA = {
  id: "mem-1",
  ownerId: "user-rosa",
  ownerName: "Rosa",
  role: "editor",
} as const

function renderSidebar(
  props: Partial<React.ComponentProps<typeof AppSidebar>> = {}
) {
  return render(
    <AppSidebar user={USER as never} open onOpenChange={vi.fn()} {...props} />
  )
}

describe("sidebar rows", () => {
  it("does not offer inventory until there is one", () => {
    renderSidebar()

    expect(screen.queryByText("Inventory")).toBeNull()
  })

  it("links the menus row to the worksheet list", () => {
    renderSidebar()

    expect(screen.getByText("Menus").closest("a")?.getAttribute("href")).toBe(
      "/menu"
    )
  })

  it("keeps supplies folded until the products family is open", () => {
    renderSidebar()

    expect(screen.queryByText("Supplies")).toBeNull()
  })

  it("opens supplies under products while on either list", () => {
    mockPathname = "/supplies"
    renderSidebar()

    const supplies = screen.getByText("Supplies").closest("a")
    expect(supplies?.getAttribute("href")).toBe("/supplies")
    expect(supplies?.getAttribute("aria-current")).toBe("page")
    // The family opens without the parent stealing the fill.
    expect(
      screen.getByText("Products").closest("a")?.getAttribute("aria-current")
    ).toBeNull()
  })

  it("keeps each integration family to one row; its pages are tabs", () => {
    mockPathname = "/integrations/sales/connections"
    renderSidebar()

    expect(
      screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => href?.startsWith("/integrations/"))
    ).toEqual(["/integrations/sales", "/integrations/suppliers"])
    expect(
      screen.getByText("Sales").closest("a")?.getAttribute("aria-current")
    ).toBe("page")
  })

  it("emails issue reports to Forkluck support", () => {
    renderSidebar()

    const link = screen.getByRole("link", { name: "Submit an issue" })
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toBe(
      "mailto:guero@forkluck.com?subject=Forkluck issue&body=Please describe what happened:\n\n"
    )
  })

  it("keeps the primary workspace rows flat", () => {
    renderSidebar()

    expect(screen.queryByRole("group", { name: "Kitchen" })).toBeNull()
    expect(screen.queryByRole("group", { name: "Sales channels" })).toBeNull()
    expect(screen.getByText("Products").closest("[role=group]")).toBeNull()
    expect(screen.getByText("Recipes").closest("[role=group]")).toBeNull()
    expect(screen.getByText("Home").closest("[role=group]")).toBeNull()
  })

  it("labels the integration families as one zone", () => {
    mockPathname = "/integrations/suppliers/mapping"
    renderSidebar()

    const zone = screen.getByRole("group", { name: "Integrations" })
    expect(screen.getByText("Sales").closest("[role=group]")).toBe(zone)
    expect(screen.getByText("Suppliers").closest("[role=group]")).toBe(zone)
    expect(
      within(zone)
        .getByText("Suppliers")
        .closest("a")
        ?.getAttribute("aria-current")
    ).toBe("page")
  })
})

describe("the sidebar inside someone else's kitchen", () => {
  it("keeps the recipe book and drops every owner-only row", () => {
    renderSidebar({ kitchen: ROSA, kitchens: [ROSA] })

    expect(
      screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => !href?.startsWith("mailto:"))
    ).toEqual(["/recipes", "/recipes/new"])
    expect(screen.queryByRole("group", { name: "Integrations" })).toBeNull()
    expect(screen.getByRole("link", { name: "Submit an issue" })).toBeDefined()
  })

  it("gives a viewer the list without the way to add to it", () => {
    renderSidebar({
      kitchen: { ...ROSA, role: "viewer" },
      kitchens: [{ ...ROSA, role: "viewer" }],
    })

    expect(screen.getByText("Recipes").closest("a")?.getAttribute("href")).toBe(
      "/recipes"
    )
    expect(screen.queryByRole("link", { name: "New recipe" })).toBeNull()
  })

  it("shows the switcher only to an account that belongs to a kitchen", () => {
    renderSidebar()
    expect(screen.queryByTestId("kitchen-switcher")).toBeNull()

    cleanup()
    renderSidebar({ kitchens: [ROSA] })
    expect(screen.getByTestId("kitchen-switcher")).toBeDefined()
  })
})
