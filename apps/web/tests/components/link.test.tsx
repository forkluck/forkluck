// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { TextLink, linkClassName } from "@/components/ui/link"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(cleanup)

describe("TextLink", () => {
  it("is a brand-blue anchor with no underline at rest", () => {
    render(<TextLink href="/ingredients">Ingredients</TextLink>)
    const link = screen.getByRole("link", { name: "Ingredients" })
    expect(link.getAttribute("href")).toBe("/ingredients")
    expect(link.className).toContain("text-primary")
    expect(link.className).toContain("hover:underline")
    expect(link.className).toContain("text-md")
    expect(linkClassName).not.toMatch(/(^|\s)underline(\s|$)/)
  })

  it("has a critical tone in the red, and no third one", () => {
    render(
      <TextLink href="/recipes/1" tone="critical">
        Delete
      </TextLink>
    )
    expect(screen.getByRole("link", { name: "Delete" }).className).toContain(
      "text-destructive"
    )
  })
})
