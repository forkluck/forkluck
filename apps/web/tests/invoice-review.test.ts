import { describe, expect, it } from "vitest"

import {
  categoryAfterItemPick,
  invoiceLineNeedsReview,
  modeAfterExpenseCategorySelection,
  receiptBlocker,
  receiptPayload,
  type ReceiptInvoice,
  type ReceiptLine,
} from "../lib/invoice-review"
import type { ExtractedLine, InvoiceLineEntry } from "../lib/invoice-import"

describe("invoice review state", () => {
  it("accepts a categorized keyless line as an expense", () => {
    expect(
      modeAfterExpenseCategorySelection({
        mode: "review",
        itemKey: "",
        categoryId: "3cbf89a8-1f62-4d28-9fb4-7f9cb37f6b46",
      })
    ).toBe("resolved")
    expect(invoiceLineNeedsReview("resolved")).toBe(false)
  })

  it("does not silently resolve lines that still need a merchant decision", () => {
    expect(
      modeAfterExpenseCategorySelection({
        mode: "review",
        itemKey: "sku-123",
        categoryId: "3cbf89a8-1f62-4d28-9fb4-7f9cb37f6b46",
      })
    ).toBe("review")
    expect(
      modeAfterExpenseCategorySelection({
        mode: "review",
        itemKey: "",
        categoryId: null,
      })
    ).toBe("review")
  })
})

const CATEGORIES = [
  {
    id: "cat-ing",
    name: "Ingredients",
    isIngredient: true,
    isSupply: false,
    position: 0,
  },
  {
    id: "cat-staff",
    name: "Staff meal",
    isIngredient: false,
    isSupply: false,
    position: 1,
  },
  {
    id: "cat-pack",
    name: "Packaging",
    isIngredient: true,
    isSupply: true,
    position: 2,
  },
  {
    id: "cat-clean",
    name: "Cleaning supplies",
    isIngredient: true,
    isSupply: true,
    position: 3,
  },
]

describe("categoryAfterItemPick", () => {
  it("files a picked food ingredient under the first food category", () => {
    expect(
      categoryAfterItemPick({
        categoryId: null,
        nonEdible: false,
        categories: CATEGORIES,
      })
    ).toBe("cat-ing")
  })

  it("files a picked supply under the first supply category", () => {
    expect(
      categoryAfterItemPick({
        categoryId: null,
        nonEdible: true,
        categories: CATEGORIES,
      })
    ).toBe("cat-pack")
  })

  it("retags a line the model filed under a non-costable category", () => {
    expect(
      categoryAfterItemPick({
        categoryId: "cat-staff",
        nonEdible: false,
        categories: CATEGORIES,
      })
    ).toBe("cat-ing")
  })

  it("leaves a costable category of the same kind", () => {
    expect(
      categoryAfterItemPick({
        categoryId: "cat-clean",
        nonEdible: true,
        categories: CATEGORIES,
      })
    ).toBe("cat-clean")
  })

  it("moves a line to the other kind when the pick says so", () => {
    expect(
      categoryAfterItemPick({
        categoryId: "cat-pack",
        nonEdible: false,
        categories: CATEGORIES,
      })
    ).toBe("cat-ing")
    expect(
      categoryAfterItemPick({
        categoryId: "cat-ing",
        nonEdible: true,
        categories: CATEGORIES,
      })
    ).toBe("cat-pack")
  })

  it("keeps what it has when the workspace has no category to move it to", () => {
    expect(
      categoryAfterItemPick({
        categoryId: "cat-staff",
        nonEdible: true,
        categories: [CATEGORIES[0], CATEGORIES[1]],
      })
    ).toBe("cat-staff")
  })
})

const RAW: ExtractedLine = {
  lineNumber: 1,
  sku: "OL-1",
  description: "Olive oil 3L",
  quantity: "2",
  unit: "CS",
  packSize: "3 L",
  unitPrice: "24.00",
  lineAmount: "48.00",
  suggestedCategory: "Ingredients",
  uncertain: false,
  uncertainReason: null,
  box: null,
}

function entry(patch: Partial<InvoiceLineEntry> = {}): InvoiceLineEntry {
  return {
    position: 0,
    sku: "OL-1",
    itemKey: "ol-1",
    description: "Olive oil 3L",
    quantity: 2,
    unit: "CS",
    packSize: "3 L",
    unitPriceCents: 2400,
    lineAmountCents: 4800,
    categoryId: "cat-ing",
    box: null,
    match: {
      kind: "update",
      supplierItemId: "si-1",
      ingredientName: "Olive oil",
      cost: {
        name: "Olive oil",
        packAmount: 3,
        packUnit: "l",
        packGrams: null,
        packPriceCents: 2400,
        rawSize: "3 L",
        preferred: true,
        ingredientId: "ing-1",
      },
    },
    uncertain: false,
    reason: null,
    raw: RAW,
    ...patch,
  }
}

function line(patch: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    entry: entry(),
    quantity: "2",
    categoryId: "cat-ing",
    mode: "auto",
    name: "",
    amount: "",
    unit: "lb",
    price: "",
    ingredientId: "",
    lineAmount: "",
    remember: true,
    ...patch,
  }
}

function invoice(patch: Partial<ReceiptInvoice> = {}): ReceiptInvoice {
  return {
    result: {
      fileName: "wegmans.pdf",
      part: { part: 0, pages: null, region: null },
      driveFileId: "drive-1",
      driveWebViewLink: null,
      supplier: "wegmans",
      supplierName: "Wegmans",
      documentType: "invoice",
      dueDate: null,
      currency: "USD",
      subtotalCents: null,
      taxCents: null,
      extractionModel: "text-layer",
      escalated: true,
      extraction: null,
      categories: CATEGORIES,
    },
    supplierName: "Wegmans Food Markets",
    invoiceNumber: " 487155 ",
    invoiceDate: "2026-08-30",
    total: "48.00",
    lines: [line()],
    ...patch,
  }
}

describe("receiptBlocker", () => {
  it("passes a receipt with a date, a total and every line amount", () => {
    expect(receiptBlocker(invoice())).toBeNull()
  })

  it("names the file that still needs a date", () => {
    expect(receiptBlocker(invoice({ invoiceDate: "" }))).toBe(
      "wegmans.pdf needs a date before importing."
    )
  })

  it("names the file whose total can't be read", () => {
    expect(receiptBlocker(invoice({ total: "about fifty" }))).toBe(
      "wegmans.pdf needs a readable total."
    )
  })

  it("asks for a line amount the extractor couldn't read", () => {
    const missing = line({ entry: entry({ lineAmountCents: null }) })
    expect(receiptBlocker(invoice({ lines: [missing] }))).toBe(
      "wegmans.pdf: enter the missing line amounts before importing."
    )
    // Typed in review, the receipt goes.
    expect(
      receiptBlocker(invoice({ lines: [{ ...missing, lineAmount: "48.00" }] }))
    ).toBeNull()
  })

  it("blocks a malformed reviewed quantity without requiring one", () => {
    expect(
      receiptBlocker(invoice({ lines: [line({ quantity: "1000001" })] }))
    ).toBe("wegmans.pdf: correct the invalid line quantities before importing.")
    expect(
      receiptBlocker(invoice({ lines: [line({ quantity: "" })] }))
    ).toBeNull()
  })
})

describe("receiptPayload", () => {
  it("files the receipt under the reviewed supplier and keeps the model's read", () => {
    const payload = receiptPayload(invoice(), [])
    expect(payload.supplierName).toBe("Wegmans Food Markets")
    expect(payload.supplier).toBe("wegmans food markets")
    expect(payload.invoiceNumber).toBe("487155")
    expect(payload.totalCents).toBe(4800)
    expect(payload.currencyCode).toBe("USD")
    expect(payload.extraction).toBeNull()
    expect(payload.escalated).toBe(true)
  })

  it("sends the part of the Drive file this receipt came out of", () => {
    expect(receiptPayload(invoice(), []).drivePart).toBe(0)

    const read = invoice()
    const second = receiptPayload(
      {
        ...read,
        result: {
          ...read.result,
          part: { part: 1, pages: { start: 2, end: 3 }, region: null },
        },
      },
      []
    )
    // Two receipts out of one scanned bundle share the file id and differ
    // only here.
    expect(second).toMatchObject({ driveFileId: "drive-1", drivePart: 1 })
  })

  it("sends the read's due date, subtotal and tax as they came back", () => {
    const read = invoice()
    const payload = receiptPayload(
      {
        ...read,
        result: {
          ...read.result,
          dueDate: "2026-09-13",
          subtotalCents: 4400,
          taxCents: 400,
        },
      },
      []
    )
    expect(payload.dueDate).toBe("2026-09-13")
    expect(payload.subtotalCents).toBe(4400)
    // The tax is inside the reviewed total, not added to it.
    expect(payload.taxCents).toBe(400)
    expect(payload.totalCents).toBe(4800)
  })

  it("sends nulls for the three when the document printed none", () => {
    const payload = receiptPayload(invoice(), [])
    expect(payload.dueDate).toBeNull()
    expect(payload.subtotalCents).toBeNull()
    expect(payload.taxCents).toBeNull()
  })

  it("takes the typed amount when the extractor read none", () => {
    const payload = receiptPayload(
      invoice({
        lines: [
          line({
            entry: entry({ lineAmountCents: null }),
            lineAmount: "12.34",
          }),
        ],
      }),
      []
    )
    expect(payload.lines[0].lineAmountCents).toBe(1234)
  })

  it("takes the reviewed quantity without rewriting the model's read", () => {
    const payload = receiptPayload(
      invoice({ lines: [line({ quantity: "2.5" })] }),
      []
    )
    expect(payload.lines[0].quantity).toBe(2.5)
    expect(payload.lines[0].costEntry?.quantity).toBe(2.5)
    expect(payload.lines[0].sourcePayload.quantity).toBe("2")
  })

  it("sends the cost entry only for a costable category, with the remember flag", () => {
    const payload = receiptPayload(invoice(), [])
    expect(payload.lines[0].costEntry).toMatchObject({
      name: "Olive oil",
      packPriceCents: 2400,
      remember: true,
    })

    const off = receiptPayload(
      invoice({ lines: [line({ remember: false })] }),
      []
    )
    expect(off.lines[0].costEntry?.remember).toBe(false)

    const expense = receiptPayload(
      invoice({ lines: [line({ categoryId: "cat-staff" })] }),
      []
    )
    expect(expense.lines[0].costEntry).toBeNull()
  })

  it("keeps the picked pantry item's own name on a resolved line", () => {
    const resolved = line({
      mode: "resolved",
      amount: "3",
      unit: "l",
      price: "24.00",
      name: "OLIVE OIL XV 3L CS",
      ingredientId: "ing-1",
      remember: false,
    })
    const payload = receiptPayload(invoice({ lines: [resolved] }), [
      { id: "ing-1", name: "Olive oil" },
    ])
    expect(payload.lines[0].costEntry).toMatchObject({
      name: "Olive oil",
      packAmount: 3,
      packUnit: "l",
      packPriceCents: 2400,
      remember: false,
    })
  })

  it("sends an ignored line to the skip list instead of the ledger", () => {
    const payload = receiptPayload(
      invoice({ lines: [line({ mode: "ignored" })] }),
      []
    )
    expect(payload.lines[0].costEntry).toBeNull()
    expect(payload.ignored).toEqual([
      {
        supplier: "wegmans food markets",
        externalId: "OL-1",
        name: "Olive oil 3L",
        rawSize: "3 L",
      },
    ])
  })
})
