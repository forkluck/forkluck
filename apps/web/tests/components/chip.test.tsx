// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Chip } from "@/components/ui/chip"

afterEach(cleanup)

describe("Chip", () => {
  it("toggles aria-pressed through onPressedChange", () => {
    const onPressedChange = vi.fn()
    const { rerender } = render(
      <Chip onPressedChange={onPressedChange}>Milk</Chip>
    )

    const chip = screen.getByRole("button", { name: "Milk" })
    expect(chip.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(chip)
    expect(onPressedChange).toHaveBeenCalledWith(true)

    rerender(
      <Chip pressed onPressedChange={onPressedChange}>
        Milk
      </Chip>
    )
    expect(
      screen.getByRole("button", { name: "Milk" }).getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("calls onRemove from the remove button", () => {
    const onRemove = vi.fn()
    render(
      <Chip onRemove={onRemove} removeLabel="Remove milk">
        Milk
      </Chip>
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove milk" }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})
