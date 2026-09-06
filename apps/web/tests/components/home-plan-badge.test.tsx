// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props} />
  ),
}))

import { HomePlanBadge } from "@/components/overview/home-plan-badge"

afterEach(cleanup)

describe("HomePlanBadge", () => {
  it("shows the Free plan and upgrade path only for free accounts", () => {
    const view = render(<HomePlanBadge freePlan />)
    expect(screen.getByText("Free")).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")
    ).toBe("/subscribe")
    view.rerender(<HomePlanBadge freePlan={false} />)
    expect(screen.queryByText("Free")).toBeNull()
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull()
  })
})
