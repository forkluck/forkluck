// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialogTarget,
} from "@/components/ui/dialog"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("the dialog fade", () => {
  it("fades scrim and card in and out, and only their opacity", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Delete this recipe?</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const card = screen.getByRole("dialog")
    const scrim = document.querySelector('[data-slot="dialog-overlay"]')
    for (const element of [card, scrim]) {
      const classes = element?.className ?? ""
      expect(classes).toContain("data-starting-style:opacity-0")
      expect(classes).toContain("data-ending-style:opacity-0")
      expect(classes).toContain("duration-150")
      expect(classes).toContain("motion-reduce:transition-none")
      // Opacity alone: the card's centering translate is not a motion.
      expect(classes).toContain("transition-opacity")
      expect(classes).not.toMatch(/scale-|blur|slide|zoom/)
    }
  })

  it("holds a dialog's target for the fade out, then lets it go", () => {
    vi.useFakeTimers()
    function Probe({ target }: { target: string | null }) {
      const held = useDialogTarget(target)
      return <output>{held ?? "gone"}</output>
    }
    const { rerender } = render(<Probe target="rec-1" />)
    expect(screen.getByRole("status").textContent).toBe("rec-1")

    rerender(<Probe target={null} />)
    // The screen has let it go; the dialog is still mounted, fading.
    expect(screen.getByRole("status").textContent).toBe("rec-1")

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(screen.getByRole("status").textContent).toBe("gone")

    // A new target shows at once, not after the hold.
    rerender(<Probe target="rec-2" />)
    expect(screen.getByRole("status").textContent).toBe("rec-2")
  })
})
