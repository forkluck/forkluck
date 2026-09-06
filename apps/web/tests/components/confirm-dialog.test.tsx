// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"

afterEach(cleanup)

function confirmButton() {
  return screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement
}

describe("a confirm that asks for a typed word", () => {
  it("keeps the confirm locked until the word matches exactly", () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete all kitchen data?"
        description="This is permanent. There is no undo."
        confirmText="DELETE"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    )

    const field = screen.getByLabelText("Type DELETE to confirm")
    expect(confirmButton().disabled).toBe(true)

    fireEvent.change(field, { target: { value: "delete" } })
    expect(confirmButton().disabled).toBe(true)
    fireEvent.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "DELETE" } })
    expect(confirmButton().disabled).toBe(false)
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it("clears the word when the dialog closes, so the next open starts locked", () => {
    const { rerender } = render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete all kitchen data?"
        description="This is permanent. There is no undo."
        confirmText="DELETE"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), {
      target: { value: "DELETE" },
    })

    const props = {
      title: "Delete all kitchen data?",
      description: "This is permanent. There is no undo.",
      confirmText: "DELETE",
      confirmLabel: "Delete",
      onOpenChange: vi.fn(),
      onConfirm: vi.fn(),
    }
    rerender(<ConfirmDialog open={false} {...props} />)
    rerender(<ConfirmDialog open {...props} />)

    expect(
      (screen.getByLabelText("Type DELETE to confirm") as HTMLInputElement)
        .value
    ).toBe("")
    expect(confirmButton().disabled).toBe(true)
  })

  it("leaves a plain confirm without a field and ready to press", () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Disconnect supplier?"
        description="New invoices stop importing."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    )

    expect(screen.queryByLabelText(/to confirm/)).toBeNull()
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
