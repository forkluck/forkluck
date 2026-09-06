// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const pathname = vi.hoisted(() => ({
  value: "/integrations/sales/connections",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
}))
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }) }))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

import { IntegrationsTitle } from "@/components/integrations/integrations-title"

afterEach(() => {
  cleanup()
  pathname.value = "/integrations/sales/connections"
})

describe("IntegrationsTitle", () => {
  it("titles the family and offers its pages as tabs", () => {
    render(<IntegrationsTitle />)

    expect(screen.getByText("Integrations")).toBeDefined()
    expect(screen.getByRole("heading", { name: "Sales" })).toBeDefined()
    const tabs = screen
      .getAllByRole("link")
      .filter((link) =>
        link.getAttribute("href")?.startsWith("/integrations/sales/")
      )
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Connections",
      "Mapping",
      "Activity",
    ])
    expect(
      screen
        .getByRole("link", { name: "Connections" })
        .getAttribute("aria-current")
    ).toBe("page")
  })

  it("keeps Mapping chosen on the tables beneath it", () => {
    pathname.value = "/integrations/sales/mapping/rules"
    render(<IntegrationsTitle />)

    expect(
      screen.getByRole("link", { name: "Mapping" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      screen
        .getByRole("link", { name: "Connections" })
        .getAttribute("aria-current")
    ).toBeNull()
  })

  it("titles the Suppliers family on its own routes", () => {
    pathname.value = "/integrations/suppliers/activity"
    render(<IntegrationsTitle />)

    expect(screen.getByRole("heading", { name: "Suppliers" })).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Activity" }).getAttribute("href")
    ).toBe("/integrations/suppliers/activity")
  })
})
