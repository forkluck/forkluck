// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props} />
  ),
  useLinkStatus: () => ({ pending: false }),
}))
vi.mock("@/components/primo/primo-home-chat", () => ({
  PrimoHomeChat: ({ tabs }: { tabs: React.ReactNode }) => (
    <section>
      {tabs}
      <h1>Ask about the kitchen.</h1>
      <textarea aria-label="Message Primo" />
    </section>
  ),
}))

import { HomeTabs } from "@/components/overview/home-tabs"

afterEach(cleanup)

describe("HomeTabs", () => {
  it("opens on Chat when Primo is available", () => {
    render(
      <HomeTabs tab={undefined} primoEnabled topProductName="" userName="Ada">
        <div>Activity dashboard</div>
      </HomeTabs>
    )
    expect(
      screen.getByRole("heading", { name: "Ask about the kitchen." })
    ).toBeDefined()
    expect(screen.getByRole("textbox", { name: "Message Primo" })).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Chat" }).getAttribute("href")
    ).toBe("/")
    expect(
      screen.getByRole("link", { name: "Activity" }).getAttribute("href")
    ).toBe("?tab=activity")
    expect(screen.queryByText("Activity dashboard")).toBeNull()
  })

  it("shows Activity when selected", () => {
    render(
      <HomeTabs tab="activity" primoEnabled topProductName="" userName="Ada">
        <div>Activity dashboard</div>
      </HomeTabs>
    )
    expect(screen.getByText("Activity dashboard")).toBeDefined()
    expect(
      screen.queryByRole("heading", { name: "Ask about the kitchen." })
    ).toBeNull()
  })

  it("shows only the dashboard when Primo is unavailable", () => {
    render(
      <HomeTabs
        tab={undefined}
        primoEnabled={false}
        topProductName=""
        userName="Ada"
      >
        <div>Activity dashboard</div>
      </HomeTabs>
    )
    expect(screen.getByText("Activity dashboard")).toBeDefined()
    expect(screen.queryByText("Chat")).toBeNull()
  })
})
