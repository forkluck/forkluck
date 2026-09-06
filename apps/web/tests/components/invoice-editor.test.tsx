// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { saveInvoice, reviewInvoiceLine, saveRef, push } = vi.hoisted(() => ({
  saveInvoice: vi.fn(),
  reviewInvoiceLine: vi.fn(),
  saveRef: { current: null as null | (() => Promise<unknown>) },
  push: vi.fn(),
}))

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveInvoice,
  reviewInvoiceLine,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}))
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ add: vi.fn() }) }))
vi.mock("@/components/invoices/invoice-chrome", () => ({
  useInvoiceEdit: () => ({
    saveRef,
    dirty: false,
    setDirty: vi.fn(),
    saveState: "saved" as const,
    setSaveState: vi.fn(),
  }),
}))

import { InvoiceEditor } from "@/components/invoices/invoice-editor"
import type { InvoiceDetail } from "@/lib/backend/schemas"
import type { ExpenseCategoryRow } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  saveRef.current = null
  saveInvoice.mockReset()
  reviewInvoiceLine.mockReset()
  window.localStorage.clear()
})

const CATEGORIES: ExpenseCategoryRow[] = [
  {
    id: "cat-produce",
    name: "Produce",
    isIngredient: false,
    isSupply: false,
    position: 1,
  },
  {
    id: "cat-ingredients",
    name: "Ingredients",
    isIngredient: true,
    isSupply: false,
    position: 2,
  },
]

function line(partial: Partial<InvoiceDetail["lines"][number]> = {}) {
  return {
    id: "line-1",
    position: 1,
    sku: "",
    description: "Napkins",
    quantity: 2,
    unit: "cs",
    packSize: "",
    currencyCode: "USD",
    unitPriceCents: 500,
    lineAmountCents: 1000,
    categoryId: "cat-produce",
    categoryName: "Produce",
    ingredientId: null,
    ingredientName: "",
    priceUpdated: false,
    needsReview: false,
    ...partial,
  }
}

/** An imported line the extractor could not place. */
function reviewLine(partial: Partial<InvoiceDetail["lines"][number]> = {}) {
  return line({
    description: "Lemons",
    categoryId: null,
    categoryName: null,
    needsReview: true,
    ...partial,
  })
}

function invoice(partial: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    publicId: "inv_1",
    editVersion: 2,
    supplier: "local-farm",
    supplierName: "Local Farm",
    documentType: "invoice",
    invoiceNumber: "A-1",
    invoiceDate: "2026-08-12",
    dueDate: null,
    totalCents: 1000,
    taxCents: 0,
    subtotalCents: null,
    notes: "",
    paymentMethod: "",
    currencyCode: "USD",
    source: "manual",
    fileName: "",
    driveWebViewLink: "",
    driveFileId: null,
    driveFilePart: null,
    documentKey: null,
    lineCount: 1,
    matchedLineCount: 0,
    unresolvedLineCount: 0,
    createdAt: new Date("2026-08-12T00:00:00Z"),
    lines: [line()],
    ...partial,
  }
}

/** Base UI opens its list off the pointer sequence, not the click alone. */
async function pick(fieldLabel: string, optionName: string) {
  const trigger = screen.getAllByLabelText(fieldLabel)[0]
  fireEvent.pointerDown(trigger)
  fireEvent.mouseDown(trigger)
  fireEvent.click(trigger)
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerDown(option)
  fireEvent.mouseDown(option)
  fireEvent.pointerUp(option)
  fireEvent.mouseUp(option)
  fireEvent.click(option)
}

function editor(initial: InvoiceDetail | null) {
  render(
    <InvoiceEditor
      initial={initial}
      supplierNames={["Local Farm"]}
      ingredients={[{ id: "ing-1", name: "Butter", nonEdible: false }]}
      categories={CATEGORIES}
      paymentMethods={[{ id: "pm-1", name: "Store credit" }]}
      currentUserId="user-1"
    />
  )
}

describe("the invoice editor", () => {
  it("adds one empty line per press of Add", () => {
    editor(null)

    expect(screen.getAllByLabelText("Description").length).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    expect(screen.getAllByLabelText("Description").length).toBe(3)
  })

  it("fills the amount from qty × unit price until it is typed over", () => {
    editor(null)

    const first = (label: string) =>
      screen.getAllByLabelText(label)[0] as HTMLInputElement
    fireEvent.change(first("Quantity"), { target: { value: "3" } })
    fireEvent.change(first("Unit price"), { target: { value: "2.50" } })
    expect(first("Amount").value).toBe("7.50")

    fireEvent.change(first("Amount"), { target: { value: "9.00" } })
    fireEvent.change(first("Quantity"), { target: { value: "4" } })
    expect(first("Amount").value).toBe("9.00")
  })

  it("keeps one blank row waiting under the lines", () => {
    editor(null)

    expect(screen.getAllByLabelText("Description").length).toBe(1)
    expect(
      (screen.getByLabelText("Description") as HTMLInputElement).placeholder
    ).toBe("Add a line…")

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Napkins" },
    })

    const rows = screen.getAllByLabelText("Description") as HTMLInputElement[]
    expect(rows.length).toBe(2)
    expect(rows[0].value).toBe("Napkins")
    expect(rows[1].value).toBe("")
  })

  it("never saves the blank row", async () => {
    saveInvoice.mockResolvedValue({ item: invoice() })
    editor(invoice())

    expect(screen.getAllByLabelText("Description").length).toBe(2)
    await saveRef.current?.()

    expect(saveInvoice.mock.calls[0][0].lines.length).toBe(1)
  })

  it("sends a category on plain lines and a cost entry on ingredient lines", async () => {
    saveInvoice.mockResolvedValue({ item: invoice() })
    editor(
      invoice({
        lines: [
          line(),
          line({
            id: "line-2",
            description: "Butter",
            categoryId: "cat-ingredients",
            categoryName: "Ingredients",
            quantity: 1,
            unitPriceCents: 800,
            lineAmountCents: 800,
            packSize: "5 LB",
          }),
        ],
      })
    )

    fireEvent.change(screen.getByLabelText("Pack size"), {
      target: { value: "5" },
    })
    fireEvent.change(screen.getByLabelText("Pack price (USD)"), {
      target: { value: "8.00" },
    })

    await saveRef.current?.()

    const payload = saveInvoice.mock.calls[0][0]
    expect(payload.lines[0].categoryId).toBe("cat-produce")
    expect(payload.lines[0].costEntry).toBeNull()
    expect(payload.lines[1].costEntry).toMatchObject({
      name: "Butter",
      packAmount: 5,
      packUnit: "lb",
      packPriceCents: 800,
      rawSize: "5 LB",
    })
    expect(payload.lines[1].packSize).toBe("5 LB")
  })

  it("suggests the saved line's price basis while an ingredient line needs review", () => {
    editor(
      invoice({
        totalCents: 30190,
        lines: [
          reviewLine({
            description: "Butter Clarified",
            quantity: 10,
            unit: "LB",
            unitPriceCents: 3019,
            lineAmountCents: 30190,
            categoryId: "cat-ingredients",
            categoryName: "Ingredients",
          }),
        ],
      })
    )

    expect((screen.getByLabelText("Pack size") as HTMLInputElement).value).toBe(
      "1"
    )
    expect(
      (screen.getByLabelText("Pack price (USD)") as HTMLInputElement).value
    ).toBe("30.19")
    expect(screen.getByLabelText("Pack size unit").textContent).toContain("lb")
  })

  it("names the ingredient match rather than its id", () => {
    editor(
      invoice({
        lines: [
          line({
            description: "Butter",
            categoryId: "cat-ingredients",
            categoryName: "Ingredients",
          }),
        ],
      })
    )

    expect(screen.getByLabelText("Match ingredient").textContent).toContain(
      "Create “Butter”"
    )
  })

  it("names the payment method rather than its wire value", async () => {
    saveInvoice.mockResolvedValue({ item: invoice() })
    editor(invoice())

    expect(screen.getByLabelText("Payment method").textContent).toContain(
      "No payment method"
    )
    await pick("Payment method", "Bank transfer")
    expect(screen.getByLabelText("Payment method").textContent).toContain(
      "Bank transfer"
    )

    await saveRef.current?.()

    expect(saveInvoice.mock.calls[0][0].paymentMethod).toBe("bank_transfer")
  })

  it("offers the workspace's own payment methods too", async () => {
    saveInvoice.mockResolvedValue({ item: invoice() })
    editor(invoice())

    await pick("Payment method", "Store credit")

    await saveRef.current?.()

    expect(saveInvoice.mock.calls[0][0].paymentMethod).toBe("Store credit")
  })

  it("says so when the lines and the total disagree", () => {
    editor(invoice({ totalCents: 1500, taxCents: 100 }))

    expect(
      screen.getByRole("status").textContent?.replace(/\s+/g, " ")
    ).toContain("Lines add up to $11.00; the total says $15.00.")
  })

  it("offers Review only on the lines that need it", () => {
    editor(
      invoice({
        source: "connector",
        lines: [reviewLine(), line({ id: "line-2", description: "Napkins" })],
      })
    )

    expect(screen.getAllByRole("button", { name: "Review" }).length).toBe(1)
  })

  it("sends the category alone when it is not an ingredient one", async () => {
    reviewInvoiceLine.mockResolvedValue({
      item: invoice({ source: "connector" }),
    })
    editor(invoice({ source: "connector", lines: [reviewLine()] }))

    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    await pick("Expense category", "Produce")
    fireEvent.click(screen.getByRole("button", { name: "Save line" }))

    await waitFor(() => expect(reviewInvoiceLine).toHaveBeenCalled())
    expect(reviewInvoiceLine.mock.calls[0][0]).toEqual({
      lineId: "line-1",
      categoryId: "cat-produce",
      costEntry: null,
    })
  })

  it("sends a cost entry when the category is an ingredient one", async () => {
    reviewInvoiceLine.mockResolvedValue({
      item: invoice({ source: "connector" }),
    })
    editor(invoice({ source: "connector", lines: [reviewLine()] }))

    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    await pick("Expense category", "Ingredients")
    fireEvent.change(screen.getByLabelText("Pack size"), {
      target: { value: "24" },
    })
    fireEvent.change(screen.getByLabelText("Pack price (USD)"), {
      target: { value: "24.50" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save line" }))

    await waitFor(() => expect(reviewInvoiceLine).toHaveBeenCalled())
    expect(reviewInvoiceLine.mock.calls[0][0].costEntry).toMatchObject({
      name: "Lemons",
      packAmount: 24,
      packUnit: "lb",
      packPriceCents: 2450,
      ingredientId: null,
    })
  })

  it("clears the review badge from the refreshed item", async () => {
    reviewInvoiceLine.mockResolvedValue({
      item: invoice({
        source: "connector",
        lines: [
          reviewLine({
            needsReview: false,
            categoryId: "cat-produce",
            categoryName: "Produce",
          }),
        ],
      }),
    })
    editor(invoice({ source: "connector", lines: [reviewLine()] }))

    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    await pick("Expense category", "Produce")
    fireEvent.click(screen.getByRole("button", { name: "Save line" }))

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Review" })).toBeNull()
    )
  })

  it("edits an imported invoice, badge and Drive link intact", () => {
    editor(
      invoice({
        source: "connector",
        driveWebViewLink: "https://drive.example/file",
        driveFileId: null,
        driveFilePart: null,
      })
    )

    expect(screen.getByText("Supplier import")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: /Open in Drive/ }).getAttribute("href")
    ).toBe("https://drive.example/file")
    expect(screen.getAllByLabelText("Description").length).toBe(2)
    expect(screen.getByRole("button", { name: "+ Add" })).toBeTruthy()
  })

  it("says which figures the document never printed", () => {
    editor(invoice({ source: "connector" }))

    expect(
      (screen.getByLabelText("Subtotal (USD)") as HTMLInputElement).value
    ).toBe("")
    expect(
      (screen.getByLabelText("Subtotal (USD)") as HTMLInputElement).placeholder
    ).toBe("Missing")
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe(
      ""
    )
  })

  it("sends the due date, the printed subtotal and the memo", async () => {
    saveInvoice.mockResolvedValue({ item: invoice() })
    editor(invoice({ source: "connector" }))

    fireEvent.change(screen.getByLabelText("Due date"), {
      target: { value: "2026-09-11" },
    })
    fireEvent.change(screen.getByLabelText("Subtotal (USD)"), {
      target: { value: "9.50" },
    })
    fireEvent.change(screen.getByLabelText("Memo"), {
      target: { value: "Short two cases" },
    })

    await saveRef.current?.()

    expect(saveInvoice.mock.calls[0][0]).toMatchObject({
      dueDate: "2026-09-11",
      subtotalCents: 950,
      notes: "Short two cases",
    })
  })

  it("puts the document's own memo and figures on the screen", () => {
    editor(
      invoice({
        source: "connector",
        dueDate: "2026-09-11",
        subtotalCents: 900,
        notes: "Left at the back door",
      })
    )

    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe(
      "2026-09-11"
    )
    expect(
      (screen.getByLabelText("Subtotal (USD)") as HTMLInputElement).value
    ).toBe("9.00")
    expect((screen.getByLabelText("Memo") as HTMLTextAreaElement).value).toBe(
      "Left at the back door"
    )
  })

  it("names the derived sum apart from the printed subtotal", () => {
    editor(invoice({ subtotalCents: 900 }))

    expect(screen.getByText("Lines add up to")).toBeTruthy()
  })
})
