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
  it("counts down the trial and offers the subscription, and only then", () => {
    const view = render(<HomePlanBadge trialDaysLeft={9} />)
    expect(screen.getByText("Trial, 9 days left")).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Subscribe" }).getAttribute("href")
    ).toBe("/subscribe")
    view.rerender(<HomePlanBadge trialDaysLeft={1} />)
    expect(screen.getByText("Trial, 1 day left")).toBeDefined()
    view.rerender(<HomePlanBadge trialDaysLeft={null} />)
    expect(screen.queryByText(/Trial/)).toBeNull()
    expect(screen.queryByRole("link", { name: "Subscribe" })).toBeNull()
  })
})
