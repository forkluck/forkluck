// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const listPaymentMethods = vi.hoisted(() => vi.fn())
const savePaymentMethod = vi.hoisted(() => vi.fn())
const deletePaymentMethod = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({
  listPaymentMethods,
  savePaymentMethod,
  deletePaymentMethod,
}))

import { PaymentMethodsDialog } from "@/components/settings/payment-methods-dialog"

const rows = [
  { id: "33333333-3333-4333-8333-333333333333", name: "Store credit" },
]

beforeEach(() => {
  listPaymentMethods.mockResolvedValue(rows)
  savePaymentMethod.mockResolvedValue({ ok: true })
  deletePaymentMethod.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function open() {
  render(<PaymentMethodsDialog open onOpenChange={vi.fn()} />)
}

describe("the payment methods dialog", () => {
  it("locks the four built-ins above the workspace's own", async () => {
    open()

    expect(await screen.findByText("Store credit")).toBeTruthy()
    expect(screen.getByText("Bank transfer")).toBeTruthy()
    expect(screen.getAllByText("Built in").length).toBe(4)
    expect(
      screen.queryByRole("button", { name: "Actions for Cash" })
    ).toBeNull()
  })

  it("adds one from the header", async () => {
    open()
    await screen.findByText("Store credit")

    fireEvent.click(screen.getByRole("button", { name: "+ Add method" }))
    const field = await screen.findByLabelText("New payment method name")
    fireEvent.change(field, { target: { value: "Voucher" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(savePaymentMethod).toHaveBeenCalledWith({ name: "Voucher" })
  })

  it("renames in place", async () => {
    open()
    await screen.findByText("Store credit")

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Store credit" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
    const field = await screen.findByLabelText("Rename Store credit")
    fireEvent.change(field, { target: { value: "House account" } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })

    expect(savePaymentMethod).toHaveBeenCalledWith({
      id: rows[0].id,
      name: "House account",
    })
    expect(screen.queryByLabelText("Rename Store credit")).toBeNull()
  })

  it("asks before the dialog closes on a new method being typed", async () => {
    const onOpenChange = vi.fn()
    render(<PaymentMethodsDialog open onOpenChange={onOpenChange} />)
    await screen.findByText("Store credit")

    fireEvent.click(screen.getByRole("button", { name: "+ Add method" }))
    const field = await screen.findByLabelText("New payment method name")
    fireEvent.change(field, { target: { value: "Voucher" } })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    expect(await screen.findByText("Discard changes?")).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("closes without asking when no rename is open", async () => {
    const onOpenChange = vi.fn()
    render(<PaymentMethodsDialog open onOpenChange={onOpenChange} />)
    await screen.findByText("Store credit")

    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("says invoices keep their text before deleting", async () => {
    open()
    await screen.findByText("Store credit")

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Store credit" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))

    expect(
      await screen.findByText(
        "Invoices paid this way keep the method they were saved with."
      )
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(deletePaymentMethod).toHaveBeenCalledWith(rows[0].id)
  })

  it("shows what the server refused", async () => {
    savePaymentMethod.mockResolvedValue({
      error: "You already have a payment method with that name",
    })
    open()
    await screen.findByText("Store credit")

    fireEvent.click(screen.getByRole("button", { name: "+ Add method" }))
    const field = await screen.findByLabelText("New payment method name")
    fireEvent.change(field, { target: { value: "store credit" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You already have a payment method with that name"
    )
    // The field stays open on a write that never landed.
    expect(screen.getByLabelText("New payment method name")).toBeTruthy()
  })
})
