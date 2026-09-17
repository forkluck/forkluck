// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { ScrollArea } from "@/components/ui/scroll-area"

afterEach(cleanup)

describe("ScrollArea", () => {
  it("renders its children inside a viewport", () => {
    render(
      <ScrollArea className="h-24">
        <p>Line 1</p>
        <p>Line 2</p>
      </ScrollArea>
    )
    const line = screen.getByText("Line 1")
    expect(line.closest("[data-slot=scroll-area-viewport]")).not.toBeNull()
    expect(line.closest("[data-slot=scroll-area]")).not.toBeNull()
  })
})
