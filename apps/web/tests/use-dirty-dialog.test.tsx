// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { useDirtyDialog } from "@/hooks/use-dirty-dialog"

/** A dialog whose Close asks first, the way every field dialog does. */
function Harness({ dirty, close }: { dirty: boolean; close: () => void }) {
  const { confirm, dialog } = useDirtyDialog()
  return (
    <>
      <button type="button" onClick={() => confirm(dirty, close)}>
        Close
      </button>
      {dialog}
    </>
  )
}

afterEach(cleanup)

describe("closing a dialog that holds nothing unsaved", () => {
  it("just closes", () => {
    const close = vi.fn()
    render(<Harness dirty={false} close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(close).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Discard changes?")).toBeNull()
  })
})

describe("closing a dirty dialog", () => {
  it("asks instead of closing", () => {
    const close = vi.fn()
    render(<Harness dirty close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(close).not.toHaveBeenCalled()
    expect(screen.getByText("Discard changes?")).not.toBeNull()
  })

  it("closes once the cook says discard", () => {
    const close = vi.fn()
    render(<Harness dirty close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    expect(close).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Discard changes?")).toBeNull()
  })

  it("keeps the edits when the cook backs out", () => {
    const close = vi.fn()
    render(<Harness dirty close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))

    expect(close).not.toHaveBeenCalled()
    expect(screen.queryByText("Discard changes?")).toBeNull()
  })

  it("keeps them on Escape too", () => {
    const close = vi.fn()
    render(<Harness dirty close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })

    expect(close).not.toHaveBeenCalled()
  })

  it("asks again the next time", () => {
    const close = vi.fn()
    render(<Harness dirty close={close} />)

    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(screen.getByText("Discard changes?")).not.toBeNull()
  })
})
