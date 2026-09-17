// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ColorField } from "@/components/ui/color-field"

afterEach(cleanup)

describe("ColorField", () => {
  it("labels the hex field and reports what is typed into it", () => {
    const onValueChange = vi.fn()
    render(
      <ColorField
        label="Chart color"
        value="#3273dc"
        onValueChange={onValueChange}
      />
    )

    const field = screen.getByLabelText("Chart color") as HTMLInputElement
    expect(field.value).toBe("#3273dc")

    fireEvent.change(field, { target: { value: "#2f7a4f" } })
    expect(onValueChange).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledWith("#2f7a4f")
  })

  it("gives the swatch a button that opens the picker", () => {
    render(
      <ColorField label="Chart color" value="#3273dc" onValueChange={vi.fn()} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose a color" }))

    expect(screen.getByLabelText("Hex value")).toBeDefined()
    expect(screen.getByRole("button", { name: "Color #3273dc" })).toBeDefined()
  })
})
