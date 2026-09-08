// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import { ToastProvider, undoableToast, useToast } from "@/components/ui/toast"

afterEach(cleanup)

function Raise({ withUndo }: { withUndo: boolean }) {
  const toast = useToast()
  React.useEffect(() => {
    toast.add(
      withUndo
        ? { title: "Archived Focaccia", actionProps: { children: "Undo" } }
        : { title: "Saved" }
    )
    // Once: the toast is the fixture, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

describe("the toast", () => {
  it("shows an action button only when the toast carries one", async () => {
    render(
      <ToastProvider>
        <Raise withUndo />
      </ToastProvider>
    )
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy()
    cleanup()
    render(
      <ToastProvider>
        <Raise withUndo={false} />
      </ToastProvider>
    )
    await screen.findByText("Saved")
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
  })
})

describe("an undoable toast", () => {
  it("holds while the undo runs, then leaves", async () => {
    const manager = {
      add: vi.fn<(options: object) => string>(() => "t1"),
      update: vi.fn(),
      close: vi.fn(),
    }
    let finish: () => void = () => undefined
    const undo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    undoableToast(manager as never, "Archived Focaccia", undo)
    expect(manager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Archived Focaccia",
        timeout: 8000,
        actionProps: expect.objectContaining({ children: "Undo" }),
      })
    )

    const options = manager.add.mock.calls[0]![0] as {
      actionProps: { onClick: () => void }
    }
    options.actionProps.onClick()
    // The clock stops and the button says what it is doing.
    expect(manager.update).toHaveBeenCalledWith("t1", {
      timeout: 0,
      actionProps: { children: "Undoing…", disabled: true },
    })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(manager.close).not.toHaveBeenCalled()

    await act(async () => finish())
    expect(manager.close).toHaveBeenCalledWith("t1")
  })
})
