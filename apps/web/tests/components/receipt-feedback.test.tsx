// @vitest-environment jsdom

import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const save = vi.fn()
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveReceiptFeedback: (input: unknown) => save(input),
}))

import { ReceiptFeedback } from "@/components/invoices/receipt-feedback"
import {
  invoiceState,
  type InvoiceState,
} from "@/components/invoices/receipt-state"
import { INGREDIENTS, parseResult } from "./receipt-fixture"

function Harness({
  initial = invoiceState("file-1", parseResult()),
}: {
  initial?: InvoiceState
}) {
  const [invoice, setInvoice] = React.useState(initial)
  return (
    <ReceiptFeedback
      invoice={invoice}
      ingredients={INGREDIENTS}
      onSaved={(feedback) =>
        setInvoice((current) => ({ ...current, feedback }))
      }
    />
  )
}

afterEach(cleanup)
beforeEach(() => {
  save.mockReset()
  save.mockResolvedValue({ ok: true })
})

describe("receipt feedback", () => {
  it("sends a negative rating, note, original read and edits without importing", async () => {
    const invoice = invoiceState("file-1", parseResult())
    invoice.lines[0].quantity = "4."
    invoice.total = ""
    render(<Harness initial={invoice} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Report a receipt problem" })
    )
    fireEvent.change(screen.getByLabelText("What went wrong? (optional)"), {
      target: { value: "Wrong quantity" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }))
    await screen.findByText("Feedback sent")
    const payload = save.mock.calls[0][0]
    expect(payload).toMatchObject({
      rating: "down",
      note: "Wrong quantity",
      model: "text-layer",
      extraction: null,
    })
    expect(payload.original.Lines[0].Quantity).toBe("1")
    expect(payload.original.Lines[0].Match).toMatchObject({
      kind: "review",
      suggestedName: "Butter",
    })
    expect(payload.corrected.Lines[0].Quantity).toBe("4.")
    expect(payload.corrected.Total).toBe("")
    expect(
      screen
        .getByRole("button", { name: "Report a receipt problem" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("accepts positive feedback without a note and updates the same report", async () => {
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: "Receipt read correctly" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }))
    await screen.findByText("Feedback sent")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(save.mock.calls[0][0]).toMatchObject({ rating: "up", note: "" })
    fireEvent.click(
      screen.getByRole("button", { name: "Report a receipt problem" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Update feedback" }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0].id).toBe(save.mock.calls[0][0].id)
    expect(save.mock.calls[1][0].rating).toBe("down")
  })

  it("keeps failed feedback open and retries with the same id", async () => {
    save.mockResolvedValueOnce({ error: "Couldn't send" })
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: "Report a receipt problem" })
    )
    fireEvent.change(screen.getByLabelText("What went wrong? (optional)"), {
      target: { value: "Highlight too low" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(
      (
        screen.getByLabelText(
          "What went wrong? (optional)"
        ) as HTMLTextAreaElement
      ).value
    ).toBe("Highlight too low")
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }))
    await screen.findByText("Feedback sent")
    expect(save.mock.calls[1][0].id).toBe(save.mock.calls[0][0].id)
  })

  it("sends one frozen snapshot while pending", async () => {
    let finish!: (value: { ok: true }) => void
    save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: "Report a receipt problem" })
    )
    const send = screen.getByRole("button", { name: "Send feedback" })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(save).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole("group", { name: "Receipt rating" }).closest("fieldset")
        ?.disabled
    ).toBe(true)
    await act(async () => {
      finish({ ok: true })
    })
  })

  it("asks before Escape discards a note", async () => {
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: "Report a receipt problem" })
    )
    fireEvent.change(screen.getByLabelText("What went wrong? (optional)"), {
      target: { value: "Missing line" },
    })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await screen.findByRole("dialog", { name: "Discard changes?" })
    expect(save).not.toHaveBeenCalled()
  })
})
