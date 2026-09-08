// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, renderHook, screen } from "@testing-library/react"

import { Kbd, useShortcutLabel } from "@/components/ui/kbd"

const platform = Object.getOwnPropertyDescriptor(navigator, "platform")

afterEach(() => {
  cleanup()
  if (platform) Object.defineProperty(navigator, "platform", platform)
})

function onPlatform(value: string) {
  Object.defineProperty(navigator, "platform", {
    value,
    configurable: true,
  })
}

describe("the key chip", () => {
  it("carries the slot the tooltip styles by", () => {
    render(<Kbd>Esc</Kbd>)
    const chip = screen.getByText("Esc")
    expect(chip.tagName).toBe("KBD")
    expect(chip.getAttribute("data-slot")).toBe("kbd")
  })

  it("names the modifier on the reader's keyboard", () => {
    onPlatform("MacIntel")
    expect(renderHook(() => useShortcutLabel("S")).result.current).toBe("⌘S")
    onPlatform("Win32")
    expect(renderHook(() => useShortcutLabel("K")).result.current).toBe(
      "Ctrl+K"
    )
  })
})
