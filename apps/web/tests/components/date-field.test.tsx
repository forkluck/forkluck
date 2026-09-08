// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { DateField } from "@/components/ui/date-field"

afterEach(cleanup)

function field(initial = "2026-08-12") {
  function Harness() {
    const [value, setValue] = React.useState(initial)
    return <DateField id="d" value={value} onChange={setValue} timeZone="UTC" />
  }
  render(<Harness />)
  return () => (screen.getByLabelText("Date") as HTMLInputElement).value
}

describe("the date field", () => {
  it("still takes a typed date", () => {
    const value = field()

    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-09-01" },
    })

    expect(value()).toBe("2026-09-01")
  })

  it("writes the day picked out of the calendar", async () => {
    const value = field()

    fireEvent.click(screen.getByRole("button", { name: "Choose date" }))
    fireEvent.click(await screen.findByRole("button", { name: "Aug 20, 2026" }))

    expect(value()).toBe("2026-08-20")
  })

  it("opens on the month the value sits in", async () => {
    field("2026-03-04")

    fireEvent.click(screen.getByRole("button", { name: "Choose date" }))

    expect(await screen.findByText("March 2026")).toBeTruthy()
  })
})
