// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { Thumbnail } from "@/components/ui/thumbnail"

afterEach(cleanup)

describe("Thumbnail", () => {
  it("shows the photo when there is one", () => {
    render(<Thumbnail src="/photo.png" alt="Butter croissant" />)
    expect(screen.getByRole("img", { name: "Butter croissant" }).tagName).toBe(
      "IMG"
    )
  })

  it("falls back to a labelled placeholder tile without a photo", () => {
    render(<Thumbnail alt="No photo" size="lg" />)
    const icon = screen.getByRole("img", { name: "No photo" })
    expect(icon.tagName).toBe("svg")
    expect(
      icon.closest("[data-slot=thumbnail]")?.getAttribute("data-size")
    ).toBe("lg")
  })
})
