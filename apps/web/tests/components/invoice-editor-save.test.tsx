// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveInvoice = vi.fn()
const reviewInvoiceLine = vi.fn()
const toastAdd = vi.fn()
const push = vi.fn()
const refresh = vi.fn()

vi.mock("@/app/(app)/ingredients/actions", () => ({
  searchCatalogIngredients: vi.fn(async () => ({ items: [] })),
  activateCatalogIngredient: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveInvoice: (...args: unknown[]) => saveInvoice(...args),
  reviewInvoiceLine: (...args: unknown[]) => reviewInvoiceLine(...args),
  deleteInvoice: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  usePathname: () => "/invoices/inv_1",
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { InvoiceChrome } from "@/components/invoices/invoice-chrome"
import { InvoiceEditor } from "@/components/invoices/invoice-editor"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"
import type { InvoiceDetail } from "@/lib/backend/schemas"
import type { ExpenseCategoryRow } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  saveInvoice.mockReset()
  reviewInvoiceLine.mockReset()
  toastAdd.mockReset()
  push.mockReset()
  refresh.mockReset()
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
]

const INVOICE_ID = "11111111-1111-4111-8111-111111111111"
const KEY = `fl.draft.v1.user-1.user-1.invoice.${INVOICE_ID}`

function invoice(partial: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: INVOICE_ID,
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
    lines: [
      {
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
      },
    ],
    ...partial,
  }
}

/** Whoever wants to leave asks the blocker first, exactly as a link does. */
function LeaveButton({ onAnswer }: { onAnswer: (allowed: boolean) => void }) {
  const { confirmNavigation } = useNavigationBlocker()
  return (
    <button
      type="button"
      onClick={() => void confirmNavigation().then(onAnswer)}
    >
      Leave
    </button>
  )
}

function savedInvoiceScreen(
  initial: InvoiceDetail = invoice(),
  onAnswer: (allowed: boolean) => void = () => undefined
) {
  render(
    <NavigationBlockerProvider>
      <InvoiceChrome title="A-1" id={initial.id} publicId={initial.publicId}>
        <InvoiceEditor
          initial={initial}
          supplierNames={["Local Farm"]}
          ingredients={[]}
          categories={CATEGORIES}
          paymentMethods={[]}
          currentUserId="user-1"
        />
      </InvoiceChrome>
      <LeaveButton onAnswer={onAnswer} />
    </NavigationBlockerProvider>
  )
}

function newInvoiceScreen(onAnswer: (allowed: boolean) => void) {
  render(
    <NavigationBlockerProvider>
      <InvoiceChrome title="New invoice">
        <InvoiceEditor
          initial={null}
          supplierNames={["Local Farm"]}
          ingredients={[]}
          categories={CATEGORIES}
          paymentMethods={[]}
          currentUserId="user-1"
        />
      </InvoiceChrome>
      <LeaveButton onAnswer={onAnswer} />
    </NavigationBlockerProvider>
  )
}

function chooseSupplier() {
  fireEvent.click(screen.getByRole("button", { name: "Supplier" }))
  fireEvent.click(screen.getByRole("button", { name: "Local Farm" }))
}

function badge() {
  return screen.getAllByRole("status")[0].textContent
}

function typeNumber(value: string) {
  fireEvent.change(screen.getByLabelText("Number"), { target: { value } })
}

describe("saving an invoice from the header", () => {
  it("keeps an unresolved imported line unresolved through an unrelated save", async () => {
    const imported = invoice({
      source: "",
      fileName: "march.pdf",
      unresolvedLineCount: 1,
      lines: [
        {
          ...invoice().lines[0],
          categoryId: null,
          categoryName: "",
          needsReview: true,
        },
      ],
    })
    saveInvoice.mockResolvedValue({
      item: { ...imported, editVersion: 3, invoiceNumber: "A-2" },
    })
    savedInvoiceScreen(imported)

    typeNumber("A-2")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveInvoice).toHaveBeenCalledTimes(1))
    expect(saveInvoice.mock.calls[0][0].lines[0].needsReview).toBe(true)
    expect(saveInvoice.mock.calls[0][0].lines[0].id).toBe(imported.lines[0].id)
  })

  it("sends the version it was given, and the one the save answered with", async () => {
    saveInvoice.mockResolvedValue({
      item: invoice({ editVersion: 3, invoiceNumber: "A-2" }),
    })
    savedInvoiceScreen()

    typeNumber("A-2")
    expect(badge()).toBe("Draft")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(badge()).toBe("Saved"))

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveInvoice).toHaveBeenCalledTimes(2))
    expect(saveInvoice.mock.calls[0][0].expectedEditVersion).toBe(2)
    expect(saveInvoice.mock.calls[1][0].expectedEditVersion).toBe(3)
    expect(saveInvoice.mock.calls[1][0].lines[0].id).toBe(invoice().lines[0].id)
  })

  it("reads Not saved after a request that failed", async () => {
    saveInvoice.mockResolvedValue({ error: "Backend is down" })
    savedInvoiceScreen()

    typeNumber("A-2")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(badge()).toBe("Not saved"))
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Backend is down" })
    )
  })

  it("stops saving and offers a way out when the invoice changed elsewhere", async () => {
    saveInvoice.mockResolvedValue({
      error:
        "This invoice changed in another window. Reload to see the latest.",
      code: "stale_write",
    })
    savedInvoiceScreen()

    typeNumber("A-2")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(badge()).toBe("Changed elsewhere"))
    expect(
      screen.getByText(
        "This invoice changed in another window. Reload to see the latest."
      )
    ).not.toBeNull()

    // The same stale version is never sent a second time.
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveInvoice).toHaveBeenCalledTimes(1))
  })
})

describe("leaving a dirty invoice", () => {
  it("saves on the way out and asks nothing", async () => {
    saveInvoice.mockResolvedValue({ item: invoice({ editVersion: 3 }) })
    const answers: boolean[] = []
    savedInvoiceScreen(invoice(), (allowed) => answers.push(allowed))

    typeNumber("A-2")
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))

    await vi.waitFor(() => expect(answers).toEqual([true]))
    expect(saveInvoice).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("changes this device kept", () => {
  it("offers to put back a draft the server never got", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        payload: {
          supplierName: "Local Farm",
          invoiceDate: "2026-08-12",
          dueDate: "",
          invoiceNumber: "A-9",
          paymentMethod: "",
          subtotal: "",
          tax: "",
          total: "10.00",
          notes: "",
          lines: [],
        },
        savedAt: Date.now(),
      })
    )
    savedInvoiceScreen()

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await vi.waitFor(() =>
      expect((screen.getByLabelText("Number") as HTMLInputElement).value).toBe(
        "A-9"
      )
    )
    expect(badge()).toBe("Draft")
  })

  it("keeps a copy while dirty and drops it once the save lands", async () => {
    saveInvoice.mockResolvedValue({ item: invoice({ editVersion: 3 }) })
    savedInvoiceScreen()

    typeNumber("A-2")
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(KEY)).not.toBeNull()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull())
  })

  it("recovers the saved identity of a line added before the draft", async () => {
    const added = {
      ...invoice().lines[0],
      id: "saved-new-line",
      description: "Flour",
    }
    const saved = invoice({
      editVersion: 3,
      lines: [...invoice().lines, added],
    })
    saveInvoice.mockResolvedValue({ item: saved })
    savedInvoiceScreen()
    fireEvent.change(screen.getAllByLabelText("Description")[1], {
      target: { value: "Flour" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
    typeNumber("Unsaved note")
    await vi.waitFor(() => {
      const draft = JSON.parse(window.localStorage.getItem(KEY)!)
      expect(draft.payload.lines[1].id).toBe(added.id)
    })
    cleanup()
    savedInvoiceScreen(saved)
    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveInvoice).toHaveBeenCalledTimes(2))
    expect(saveInvoice.mock.calls[1][0].lines[1].id).toBe(added.id)
  })
})

describe("reviewing one line of an imported invoice", () => {
  it("files the line on its own, without touching the document", async () => {
    const imported = invoice({
      source: "connector",
      lines: [
        {
          ...invoice().lines[0],
          categoryId: null,
          categoryName: null,
          needsReview: true,
        },
      ],
    })
    reviewInvoiceLine.mockResolvedValue({
      item: invoice({
        source: "connector",
        lines: [{ ...invoice().lines[0], needsReview: false }],
      }),
    })
    savedInvoiceScreen(imported)

    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    fireEvent.click(screen.getByRole("button", { name: "Save line" }))

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    // The review is its own conflict domain: it never sends the document and
    // never bumps its version. The refresh it asks for is what puts the
    // server's lines back under the editor, which the page remounts on.
    expect(saveInvoice).not.toHaveBeenCalled()
    expect(reviewInvoiceLine).toHaveBeenCalledTimes(1)
  })

  it("stops offering Review once the document is dirty", () => {
    const imported = invoice({
      source: "connector",
      lines: [
        {
          ...invoice().lines[0],
          categoryId: null,
          categoryName: null,
          needsReview: true,
        },
      ],
    })
    savedInvoiceScreen(imported)

    expect(
      screen.getByRole("button", { name: "Review" }).hasAttribute("disabled")
    ).toBe(false)

    // Saving the line replaces every line with the server's answer, so it is
    // withheld while there are unsaved edits for it to throw away.
    typeNumber("A-2")
    expect(
      screen.getByRole("button", { name: "Review" }).hasAttribute("disabled")
    ).toBe(true)
  })
})

describe("saving a new invoice twice", () => {
  it("sends the id the create answered with instead of creating again", async () => {
    let land: (value: unknown) => void = () => undefined
    saveInvoice
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            land = resolve
          })
      )
      .mockResolvedValue({ item: invoice({ editVersion: 4 }) })
    const answers: boolean[] = []
    newInvoiceScreen((allowed) => answers.push(allowed))

    chooseSupplier()
    typeNumber("A-2")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveInvoice).toHaveBeenCalledTimes(1))

    typeNumber("A-3")
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))
    land({ item: invoice({ editVersion: 3 }) })

    await vi.waitFor(() => expect(answers).toEqual([true]))
    expect(saveInvoice).toHaveBeenCalledTimes(2)
    expect(saveInvoice.mock.calls[0][0].id).toBeUndefined()
    expect(saveInvoice.mock.calls[1][0].id).toBe(INVOICE_ID)
  })
})
