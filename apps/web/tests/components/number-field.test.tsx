// @vitest-environment jsdom

import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { NumberField } from "@/components/ui/number-field"

afterEach(cleanup)

function BatchSize() {
  const [value, setValue] = useState<number | null>(2)

  return (
    <NumberField
      label="Batches"
      value={value}
      onValueChange={(next) => setValue(next)}
      min={1}
      max={3}
      step={1}
    />
  )
}

describe("NumberField", () => {
  it("exposes a spinbutton labelled by its own label", () => {
    render(<BatchSize />)

    const spinbutton = screen.getByRole("spinbutton", { name: "Batches" })
    expect((spinbutton as HTMLInputElement).value).toBe("2")
    expect(spinbutton.getAttribute("aria-valuenow")).toBe("2")
    expect(spinbutton.getAttribute("aria-valuemin")).toBe("1")
    expect(spinbutton.getAttribute("aria-valuemax")).toBe("3")
  })

  it("steps the value with the increment and decrement buttons", () => {
    render(<BatchSize />)

    const spinbutton = screen.getByRole("spinbutton", { name: "Batches" })

    fireEvent.click(screen.getByRole("button", { name: "Increase" }))
    expect((spinbutton as HTMLInputElement).value).toBe("3")

    fireEvent.click(screen.getByRole("button", { name: "Decrease" }))
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }))
    expect((spinbutton as HTMLInputElement).value).toBe("1")
  })

  it("holds the value inside min and max", () => {
    render(<BatchSize />)

    const spinbutton = screen.getByRole("spinbutton", { name: "Batches" })
    const increase = screen.getByRole("button", { name: "Increase" })
    const decrease = screen.getByRole("button", { name: "Decrease" })

    fireEvent.click(increase)
    fireEvent.click(increase)
    fireEvent.click(increase)
    expect((spinbutton as HTMLInputElement).value).toBe("3")

    fireEvent.click(decrease)
    fireEvent.click(decrease)
    fireEvent.click(decrease)
    expect((spinbutton as HTMLInputElement).value).toBe("1")
  })

  it("stops stepping when disabled", () => {
    render(
      <NumberField
        label="Batches"
        value={2}
        min={1}
        max={9}
        step={1}
        disabled
      />
    )

    const increase = screen.getByRole("button", { name: "Increase" })
    expect(increase.hasAttribute("disabled")).toBe(true)
    fireEvent.click(increase)
    expect(
      (screen.getByRole("spinbutton", { name: "Batches" }) as HTMLInputElement)
        .value
    ).toBe("2")
  })
})
