import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * What `saveInvoice` puts on the wire and what it refuses before it gets there.
 *
 * Hand entry sends a shorter line than an import does, so the action fills the
 * rest in; Django reads one shape either way. The backend tests post to Django
 * directly and never exercise this seam.
 */

const STORE_USER = "11111111-1111-4111-8111-111111111111"
const sent: { slug: string; body: Record<string, unknown> }[] = []
const revalidated: string[] = []
let rejection: unknown = null

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path)
  },
}))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({ id: STORE_USER }),
}))
vi.mock("@/lib/backend/queries", () => ({
  getConnectorSyncRun: () => Promise.resolve({}),
  getInvoiceLines: () => Promise.resolve({}),
}))
vi.mock("@/lib/invoice-extract", () => ({
  verifyAnthropicKey: () => Promise.resolve({}),
}))
// The real error classes come through: actionErrorMessage narrows on them.
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction: (slug: string, body: Record<string, unknown>) => {
    sent.push({ slug, body })
    return rejection
      ? Promise.reject(rejection)
      : Promise.resolve({ item: { publicId: "inv_1" } })
  },
}))

const { importInvoices, saveInvoice, saveReceiptFeedback } =
  await import("@/app/(app)/invoices/actions")
import { invoiceExtractionSchema } from "@/lib/invoice-import"
import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"

const line = { description: "Carrots", lineAmountCents: 7350 }
const invoice = {
  supplierName: "Corner Market",
  invoiceDate: "2026-07-14",
  totalCents: 7850,
  lines: [line],
}

describe("saveReceiptFeedback", () => {
  const feedback = {
    id: "11111111-2222-4333-8444-555555555555",
    rating: "down" as const,
    note: "  Wrong quantity  ",
    fileName: "sample.pdf",
    supplierName: "Example Market",
    model: "text-layer",
    extraction: null,
    original: { Quantity: "4" },
    corrected: { Quantity: "" },
  }

  beforeEach(() => {
    sent.length = 0
    rejection = null
  })

  it("validates and forwards the report to the authenticated backend action", async () => {
    await saveReceiptFeedback(feedback)
    expect(sent).toEqual([
      {
        slug: "save-receipt-feedback",
        body: { ...feedback, note: "Wrong quantity" },
      },
    ])
  })

  it.each([
    { id: "bad" },
    { rating: "bad" },
    { note: "x".repeat(2001) },
    { original: { huge: "x".repeat(65536) } },
    { corrected: null },
  ])("refuses malformed feedback before sending: %j", async (patch) => {
    expect(
      await saveReceiptFeedback({ ...feedback, ...patch } as Parameters<
        typeof saveReceiptFeedback
      >[0])
    ).toHaveProperty("error")
    expect(sent).toEqual([])
  })

  it("returns a usable failure so the dialog can retain and retry the report", async () => {
    rejection = new Error("connection dropped")
    expect(await saveReceiptFeedback(feedback)).toHaveProperty("error")
  })
})

describe("saveInvoice", () => {
  beforeEach(() => {
    sent.length = 0
    revalidated.length = 0
    rejection = null
  })

  it("fills in every field hand entry leaves out", async () => {
    expect(await saveInvoice(invoice)).toEqual({ item: { publicId: "inv_1" } })

    expect(sent).toEqual([
      {
        slug: "save-invoice",
        body: {
          id: null,
          supplierName: "Corner Market",
          invoiceNumber: "",
          invoiceDate: "2026-07-14",
          dueDate: null,
          totalCents: 7850,
          taxCents: 0,
          subtotalCents: null,
          notes: "",
          paymentMethod: "",
          lines: [
            {
              sku: "",
              description: "Carrots",
              quantity: null,
              unit: "",
              packSize: "",
              unitPriceCents: null,
              lineAmountCents: 7350,
              categoryId: null,
              needsReview: false,
              sourcePayload: {},
              costEntry: null,
            },
          ],
        },
      },
    ])
  })

  it("revalidates the invoice, pantry and dashboard reads", async () => {
    await saveInvoice(invoice)

    expect(revalidated.sort()).toEqual(["/", "/ingredients", "/invoices"])
  })

  it("preserves existing row identity and distinguishes a new repeated line", async () => {
    const id = "22222222-2222-4222-8222-222222222222"
    await saveInvoice({
      ...invoice,
      lines: [
        { ...line, id },
        { ...line, id: null },
      ],
    })
    expect(sent[0].body.lines).toEqual([
      expect.objectContaining({ id, description: "Carrots" }),
      expect.objectContaining({ id: null, description: "Carrots" }),
    ])
  })

  it("refuses an incomplete header before it reaches Django", async () => {
    expect(await saveInvoice({ ...invoice, supplierName: "  " })).toEqual({
      error: "Enter the supplier name.",
    })
    expect(
      await saveInvoice({ ...invoice, invoiceDate: "14/07/2026" })
    ).toEqual({ error: "Enter the invoice date." })
    expect(await saveInvoice({ ...invoice, lines: [] })).toEqual({
      error: "Add at least one line.",
    })
    expect(sent).toEqual([])
    expect(revalidated).toEqual([])
  })

  it("sends a negative total on for Django to judge", async () => {
    // Only the row knows whether this is a credit memo, so the sign is not
    // the browser's to refuse any more.
    expect(
      await saveInvoice({ ...invoice, totalCents: -500 })
    ).not.toHaveProperty("error")

    expect(sent[0].body.totalCents).toBe(-500)
  })

  it("passes a workspace method through and refuses one past the column", async () => {
    expect(
      await saveInvoice({ ...invoice, paymentMethod: "Store credit" })
    ).not.toHaveProperty("error")
    expect(sent[0].body.paymentMethod).toBe("Store credit")

    expect(
      await saveInvoice({ ...invoice, paymentMethod: "x".repeat(65) })
    ).toHaveProperty("error")
    expect(sent.length).toBe(1)
  })

  it("reports a failure instead of throwing, and revalidates nothing", async () => {
    rejection = { status: 500 }

    expect(await saveInvoice(invoice)).toEqual({
      error: "Couldn't save that invoice.",
    })
    expect(revalidated).toEqual([])
  })
})

describe("importInvoices", () => {
  const importLine = {
    sku: "CAR10",
    description: "Carrots",
    quantity: 3,
    unit: "CS",
    packSize: "24 X 1 LB",
    unitPriceCents: 2450,
    lineAmountCents: 7350,
    categoryId: null,
    needsReview: false,
    sourcePayload: {},
    costEntry: null,
  }
  const importInvoice = {
    fileName: "invoice.pdf",
    driveFileId: null,
    driveWebViewLink: null,
    supplier: "harbor",
    supplierName: "Harbor Supply",
    documentType: "invoice" as const,
    invoiceNumber: "IV101",
    invoiceDate: "2026-07-14",
    currencyCode: null,
    totalCents: 7350,
    extractionModel: "text-layer",
    extraction: null,
    escalated: false,
    lines: [importLine],
    ignored: [],
  }

  beforeEach(() => {
    sent.length = 0
    rejection = null
  })

  it("puts the read and the escalation flag on the wire beside the invoice", async () => {
    const extraction = invoiceExtractionSchema.parse(baldorInvoice)

    expect(
      await importInvoices({
        invoices: [{ ...importInvoice, extraction, escalated: true }],
        reviewedCurrencyCode: "USD",
      })
    ).not.toHaveProperty("error")

    const invoices = sent[0].body.invoices as Record<string, unknown>[]
    expect(sent[0].slug).toBe("import-invoices")
    expect(invoices[0].extraction).toEqual(extraction)
    expect(invoices[0].escalated).toBe(true)
  })

  it("sends a null read for a document nothing was kept from", async () => {
    expect(
      await importInvoices({
        invoices: [importInvoice],
        reviewedCurrencyCode: "USD",
      })
    ).not.toHaveProperty("error")

    const invoices = sent[0].body.invoices as Record<string, unknown>[]
    expect(invoices[0].extraction).toBeNull()
    expect(invoices[0].escalated).toBe(false)
  })

  it("sends the key of the file it kept, and refuses another user's", async () => {
    const documentKey = `${STORE_USER}/33333333-3333-4333-8333-333333333333.pdf`
    await importInvoices({
      invoices: [{ ...importInvoice, documentKey }],
      reviewedCurrencyCode: "USD",
    })
    const invoices = sent[0].body.invoices as Record<string, unknown>[]
    expect(invoices[0].documentKey).toBe(documentKey)

    sent.length = 0
    // A key from the browser is not authorization: it names one user's file.
    expect(
      await importInvoices({
        invoices: [
          {
            ...importInvoice,
            documentKey:
              "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.pdf",
          },
        ],
        reviewedCurrencyCode: "USD",
      })
    ).toHaveProperty("error")
    expect(sent).toHaveLength(0)
  })

  it("sends null for the figures a document did not print", async () => {
    await importInvoices({
      invoices: [importInvoice],
      reviewedCurrencyCode: "USD",
    })

    const invoices = sent[0].body.invoices as Record<string, unknown>[]
    expect(invoices[0].dueDate).toBeNull()
    expect(invoices[0].taxCents).toBeNull()
    expect(invoices[0].subtotalCents).toBeNull()
  })
})
