// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Toggle } from "@/components/ui/toggle"

afterEach(cleanup)

describe("Toggle", () => {
  it("toggles aria-pressed when pressed", () => {
    render(<Toggle>Show costs</Toggle>)

    const toggle = screen.getByRole("button", { name: "Show costs" })
    expect(toggle.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
  })
})
