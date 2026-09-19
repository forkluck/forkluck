// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ColorPicker } from "@/components/ui/color-picker"

afterEach(cleanup)

describe("ColorPicker", () => {
  it("reports the hex of the swatch that was pressed", () => {
    const onValueChange = vi.fn()
    render(<ColorPicker value="#3273dc" onValueChange={onValueChange} />)

    fireEvent.click(screen.getByRole("button", { name: "Color #14532d" }))

    expect(onValueChange).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledWith("#14532d")
  })

  it("marks the selected swatch and leaves the others alone", () => {
    render(<ColorPicker value="#D92D20" onValueChange={vi.fn()} />)

    expect(
      screen
        .getByRole("button", { name: "Color #d92d20" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(
      screen
        .getByRole("button", { name: "Color #3273dc" })
        .getAttribute("aria-pressed")
    ).toBe("false")
  })

  it("only reports a hex field edit once it is a whole colour", () => {
    const onValueChange = vi.fn()
    render(<ColorPicker value="#3273dc" onValueChange={onValueChange} />)
    const field = screen.getByLabelText("Hex value")

    fireEvent.change(field, { target: { value: "#2f7a" } })
    expect(onValueChange).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "#2F7A4F" } })
    expect(onValueChange).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledWith("#2f7a4f")
  })

  it("renders the swatches a call site passes instead of the palette", () => {
    render(
      <ColorPicker
        value="#18181b"
        onValueChange={vi.fn()}
        swatches={["#18181b", "#3273dc"]}
      />
    )

    expect(screen.getAllByLabelText(/^Color #/)).toHaveLength(2)
  })
})
