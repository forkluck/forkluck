// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { deleteInvoice, push } = vi.hoisted(() => ({
  deleteInvoice: vi.fn(),
  push: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({ deleteInvoice }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))
vi.mock("@/components/navigation-blocker", () => ({
  GuardedLink: ({
    href,
    children,
  }: {
    href: string
    children?: React.ReactNode
  }) => <a href={href}>{children}</a>,
  useNavigationBlocker: () => ({
    setIsBlocked: vi.fn(),
    allowNavigation: vi.fn(),
  }),
}))

import { InvoiceChrome } from "@/components/invoices/invoice-chrome"

afterEach(cleanup)

describe("the invoice header", () => {
  it("asks before deleting, then leaves for the list", async () => {
    deleteInvoice.mockResolvedValue({ ok: true })
    render(
      <InvoiceChrome title="A-1" id="inv-1" publicId="inv_1">
        <p>Lines</p>
      </InvoiceChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))
    fireEvent.click(await screen.findByText("Delete invoice"))

    expect(await screen.findByText("Delete this invoice?")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete invoice" }))

    await waitFor(() => expect(deleteInvoice).toHaveBeenCalledWith("inv-1"))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoices"))
  })

  it("returns to the invoices view the receipt was opened from", async () => {
    deleteInvoice.mockResolvedValue({ ok: true })
    render(
      <InvoiceChrome
        title="A-1"
        id="inv-1"
        publicId="inv_1"
        listHref="/invoices?month=2026-07"
      >
        <p>Lines</p>
      </InvoiceChrome>
    )

    expect(
      screen.getByRole("link", { name: "Invoices" }).getAttribute("href")
    ).toBe("/invoices?month=2026-07")

    fireEvent.click(screen.getByRole("button", { name: /Actions/ }))
    fireEvent.click(await screen.findByText("Delete invoice"))
    fireEvent.click(screen.getByRole("button", { name: "Delete invoice" }))

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/invoices?month=2026-07")
    )
  })

  it("offers Save and the document it was read from on every invoice", () => {
    render(
      <InvoiceChrome
        title="A-1"
        id="inv-1"
        publicId="inv_1"
        driveWebViewLink="https://drive.example/file"
      >
        <p>Lines</p>
      </InvoiceChrome>
    )

    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Invoices" })).toBeTruthy()
  })
})
