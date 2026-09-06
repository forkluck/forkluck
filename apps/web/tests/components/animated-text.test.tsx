// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

import { AnimatedText } from "@/components/primo/animated-text"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("AnimatedText", () => {
  it("never marks hydrated text for animation", () => {
    const { container } = render(
      <AnimatedText text="Saved answer" animate={false} />
    )
    expect(container.querySelector(".primo-word-arrival")).toBeNull()
  })

  it("marks only arriving words and leaves reduced motion to CSS", () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <AnimatedText text="Fresh" animate />
    )
    expect(container.querySelectorAll(".primo-word-arrival")).toHaveLength(1)
    act(() => vi.advanceTimersByTime(550))
    rerender(<AnimatedText text="Fresh answer" animate />)
    expect(container.querySelectorAll(".primo-word-arrival")).toHaveLength(1)
  })
})
