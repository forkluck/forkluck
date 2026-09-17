// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

afterEach(cleanup)

function ColumnsPopover() {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline">Columns</Button>} />
      <PopoverContent>
        <p>Pick the columns this table shows.</p>
      </PopoverContent>
    </Popover>
  )
}

describe("Popover", () => {
  it("opens its content on a click and closes again", () => {
    render(<ColumnsPopover />)

    expect(screen.queryByText("Pick the columns this table shows.")).toBeNull()

    const trigger = screen.getByRole("button", { name: "Columns" })
    fireEvent.click(trigger)
    expect(screen.getByText("Pick the columns this table shows.")).toBeDefined()

    fireEvent.click(trigger)
    expect(screen.queryByText("Pick the columns this table shows.")).toBeNull()
  })

  it("marks the trigger as expanded while the popover is open", () => {
    render(<ColumnsPopover />)

    const trigger = screen.getByRole("button", { name: "Columns" })
    expect(trigger.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
  })
})
