// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Button } from "@/components/ui/button"

afterEach(cleanup)

describe("Button pending", () => {
  it("disables the button, announces busy, and shows the spinner", () => {
    render(<Button pending>Save</Button>)

    const button = screen.getByRole("button", { name: /Save/ })
    expect(button.hasAttribute("disabled")).toBe(true)
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.querySelector("[role='status']")).not.toBeNull()
    // The label stays readable through the wait.
    expect(button.textContent).toContain("Save")
  })

  it("drops presses while pending", () => {
    const onClick = vi.fn()
    render(
      <Button pending onClick={onClick}>
        Save
      </Button>
    )

    fireEvent.click(screen.getByRole("button", { name: /Save/ }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it("stays an ordinary button when not pending", () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)

    const button = screen.getByRole("button", { name: "Save" })
    expect(button.hasAttribute("disabled")).toBe(false)
    expect(button.getAttribute("aria-busy")).toBeNull()
    expect(button.querySelector("[role='status']")).toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
