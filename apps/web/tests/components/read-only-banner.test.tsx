// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props} />
  ),
}))

import { ReadOnlyBanner } from "@/components/billing/read-only-banner"

afterEach(cleanup)

describe("ReadOnlyBanner", () => {
  it("shows the sentence it was given beside the way to subscribe", () => {
    render(
      <ReadOnlyBanner notice="Your trial ended. Subscribe to keep editing." />
    )
    expect(
      screen.getByText("Your trial ended. Subscribe to keep editing.")
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Subscribe" }).getAttribute("href")
    ).toBe("/subscribe")
  })
})
