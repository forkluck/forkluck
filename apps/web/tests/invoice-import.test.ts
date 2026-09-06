import { zodSchema } from "ai"
import { describe, expect, it } from "vitest"

import {
  type InvoiceExtraction,
  buildInvoiceParseResult,
  bundleRefusal,
  cleanUnit,
  invoiceExtractionSchema,
  multiDocumentCount,
  storedDriveDocumentSchema,
  normalizeInvoiceExtraction,
  parseMoneyToCents,
  parseQuantity,
  supplierItemKey,
  supplierKeyFromName,
  packUnitFromLabel,
  type InvoiceLineStatus,
  type InvoiceLineStatusItem,
  type NormalizedInvoice,
} from "../lib/invoice-import"
import baldorCreditMemo from "./fixtures/invoices/baldor-credit-memo.json"
import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"
import itemKeyCases from "./fixtures/supplier-item-keys.json"

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
    id: "cat-other",
    name: "Other",
    isIngredient: false,
    isSupply: false,
    position: 7,
  },
]

function emptyStatus(
  overrides: Partial<InvoiceLineStatus> = {}
): InvoiceLineStatus {
  return {
    items: [],
    duplicate: false,
    existingInvoice: null,
    categories: CATEGORIES,
    ...overrides,
  }
}

function statusItem(
  index: number,
  overrides: Partial<InvoiceLineStatusItem> = {}
): InvoiceLineStatusItem {
  return {
    index,
    supplierItem: null,
    ignored: false,
    matchedIngredientId: null,
    matchedIngredientName: null,
    lastCategoryId: null,
    ...overrides,
  }
}

const CARROT_ITEM: NonNullable<InvoiceLineStatusItem["supplierItem"]> = {
  id: "item-car10",
  ingredientId: "ing-carrots",
  ingredientName: "Carrots baby orange",
  title: "Carrots baby orange",
  rawSize: "24 X 1 LB",
  packPriceCents: 2300,
  packAmount: 24,
  packUnit: "lb",
  packGrams: 10886,
  isPreferred: true,
}

/** A Wegmans-style catch-weight line: no item code, priced by the pound. */
const CREAM_LINE = {
  lineNumber: 1,
  sku: null,
  description: "OG HVY WHP CRM UHT",
  quantity: "2.02",
  unit: "lb",
  packSize: null,
  unitPrice: "2.99",
  lineAmount: "6.04",
  suggestedCategory: "Ingredients",
  uncertain: false,
  uncertainReason: null,
  box: null,
}

function normalizeFixture(fixture: unknown): NormalizedInvoice {
  const extraction = invoiceExtractionSchema.parse(fixture)
  const normalized = normalizeInvoiceExtraction(extraction)
  if ("error" in normalized) throw new Error(normalized.error)
  return normalized
}

const FILE = {
  fileName: "invoice.pdf",
  driveFileId: "drive-1",
  driveWebViewLink: "https://drive.google.com/file/d/drive-1/view",
  extractionModel: "text-layer",
  escalated: false,
  extraction: null,
}

describe("extraction schema", () => {
  it("parses the checked-in fixtures so they can't drift", () => {
    expect(() => invoiceExtractionSchema.parse(baldorInvoice)).not.toThrow()
    expect(() => invoiceExtractionSchema.parse(baldorCreditMemo)).not.toThrow()
  })

  it("still reads a stored document written before due date, subtotal and tax", () => {
    const { dueDate, subtotalAmount, taxAmount, ...older } = baldorInvoice
    void dueDate
    void subtotalAmount
    void taxAmount
    const parsed = invoiceExtractionSchema.parse(older)
    expect(parsed.dueDate).toBeNull()
    expect(parsed.subtotalAmount).toBeNull()
    expect(parsed.taxAmount).toBeNull()
  })
})

describe("parseMoneyToCents", () => {
  it("reads printed money formats", () => {
    expect(parseMoneyToCents("1,234.56")).toBe(123456)
    expect(parseMoneyToCents("$24.50")).toBe(2450)
    expect(parseMoneyToCents("-12.34")).toBe(-1234)
    expect(parseMoneyToCents("(12.34)")).toBe(-1234)
    expect(parseMoneyToCents("$0.00")).toBe(0)
    expect(parseMoneyToCents("42")).toBe(4200)
  })

  it("returns null for anything unreadable", () => {
    expect(parseMoneyToCents(null)).toBeNull()
    expect(parseMoneyToCents("")).toBeNull()
    expect(parseMoneyToCents("12,34")).toBeNull()
    expect(parseMoneyToCents("N/A")).toBeNull()
    expect(parseMoneyToCents("12.34.56")).toBeNull()
  })

  it("defers a lone three-digit dot group rather than misreading it 1000x", () => {
    // European whole thousands: reading "1.234" as 123¢ scales quantity, unit
    // price, amount and total together, so every arithmetic gate still passes.
    expect(parseMoneyToCents("1.234")).toBeNull()
    expect(parseMoneyToCents("1.23")).toBe(123)
    expect(parseMoneyToCents("1234.56")).toBe(123456)
    expect(parseMoneyToCents("1,234.56")).toBe(123456)
  })
})

describe("parseQuantity", () => {
  it("reads decimal strings and rejects garbage", () => {
    expect(parseQuantity("3")).toBe(3)
    expect(parseQuantity("12.5")).toBe(12.5)
    expect(parseQuantity("-3")).toBe(-3)
    expect(parseQuantity("1,000")).toBe(1000)
    expect(parseQuantity("a few")).toBeNull()
    expect(parseQuantity(null)).toBeNull()
  })
})

describe("supplierKeyFromName", () => {
  it("collapses Baldor variants onto the spreadsheet import's key", () => {
    expect(supplierKeyFromName("Baldor Specialty Foods Inc.")).toBe("baldor")
    expect(supplierKeyFromName("BALDOR SPECIALTY FOODS")).toBe("baldor")
  })

  it("strips corporate suffixes from other suppliers", () => {
    expect(supplierKeyFromName("Harbor Supply LLC")).toBe("harbor supply")
    expect(supplierKeyFromName("Acme Provisions, Inc.")).toBe("acme provisions")
  })
})

describe("packUnitFromLabel", () => {
  it("maps a printed U/M to the unit the line is priced by", () => {
    expect(packUnitFromLabel("LB")).toBe("lb")
    expect(packUnitFromLabel("lbs.")).toBe("lb")
    expect(packUnitFromLabel("KG")).toBe("kg")
    expect(packUnitFromLabel("GAL")).toBe("gal")
    expect(packUnitFromLabel("EA")).toBe("each")
    expect(packUnitFromLabel("CT")).toBe("each")
    expect(packUnitFromLabel("DZ")).toBe("dozen")
  })

  it("reads a container column as no price basis of its own", () => {
    // A case is priced by what its pack-size column says it holds.
    expect(packUnitFromLabel("CS")).toBeNull()
    expect(packUnitFromLabel("BOX")).toBeNull()
    expect(packUnitFromLabel("")).toBeNull()
  })
})

describe("cleanUnit", () => {
  it("drops a till receipt's tax flag and its @, and keeps real units", () => {
    expect(cleanUnit("F")).toBe("")
    expect(cleanUnit("B")).toBe("")
    expect(cleanUnit("@")).toBe("")
    expect(cleanUnit(" T ")).toBe("")
    expect(cleanUnit("20")).toBe("")
    expect(cleanUnit("g")).toBe("g")
    expect(cleanUnit("L")).toBe("L")
    expect(cleanUnit("CS")).toBe("CS")
    expect(cleanUnit("lb")).toBe("lb")
  })
})

describe("normalizeInvoiceExtraction", () => {
  function prefixReceipt() {
    return {
      ...baldorInvoice,
      supplierName: "Wegmans",
      documentType: "receipt" as const,
      totalAmount: "11.49",
      otherChargesAmount: null,
      lines: [
        {
          ...CREAM_LINE,
          description: "DELI ITEM",
          quantity: "4",
          unit: "F",
          unitPrice: "1.50",
          lineAmount: "5.49",
          box: { page: 0, bbox_2d: [10, 100, 900, 120] },
        },
        {
          ...CREAM_LINE,
          description: "PEARS",
          quantity: null as string | null,
          unit: "F",
          unitPrice: null as string | null,
          lineAmount: "6.00",
          box: { page: 0, bbox_2d: [10, 140, 900, 160] },
        },
      ],
    }
  }

  it.each(["fields", "pack only", "pack with inferred price"])(
    "aligns a Wegmans quantity prefix from %s without moving amounts or identity",
    (form) => {
      const receipt = prefixReceipt()
      if (form !== "fields") {
        Object.assign(receipt.lines[0], {
          packSize: "4 @ 1.50",
          unitPrice: form === "pack only" ? null : "1.37",
        })
      }
      const original = structuredClone(receipt)
      const invoice = normalizeFixture(receipt)
      expect(
        invoice.lines.map(
          ({
            description,
            quantity,
            unitPriceCents,
            lineAmountCents,
            uncertain,
          }) => ({
            description,
            quantity,
            unitPriceCents,
            lineAmountCents,
            uncertain,
          })
        )
      ).toEqual([
        {
          description: "DELI ITEM",
          quantity: null,
          unitPriceCents: null,
          lineAmountCents: 549,
          uncertain: false,
        },
        {
          description: "PEARS",
          quantity: 4,
          unitPriceCents: 150,
          lineAmountCents: 600,
          uncertain: false,
        },
      ])
      expect(invoice.lines[0].box?.y0).toBe(0.1)
      expect(invoice.lines[1].box?.y0).toBe(0.14)
      expect(invoice.lines[0].raw).toEqual(original.lines[0])
      expect(receipt).toEqual(original)
      expect(invoice.totalsMismatch).toBeNull()
      const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
      expect(result.lines[1].match.kind).toBe("review")
      if (result.lines[1].match.kind === "review") {
        expect(result.lines[1].match.suggestedPriceCents).toBe(150)
      }
    }
  )

  it.each([
    "another supplier",
    "invoice table",
    "already reconciles",
    "wrong next amount",
    "next quantity",
    "next unit price",
    "explicit unit",
    "another page",
    "missing box",
    "reversed boxes",
    "uncertain source",
    "uncertain next",
    "negative pair",
    "nonadjacent match",
  ])("does not move a prefix when %s", (scenario) => {
    const receipt = prefixReceipt()
    const [source, next] = receipt.lines
    if (scenario === "another supplier") receipt.supplierName = "Example Grocer"
    if (scenario === "invoice table")
      Object.assign(receipt, { documentType: "invoice" })
    if (scenario === "already reconciles") source.lineAmount = "6.00"
    if (scenario === "wrong next amount") next.lineAmount = "7.00"
    if (scenario === "next quantity") next.quantity = "1"
    if (scenario === "next unit price") next.unitPrice = "6.00"
    if (scenario === "explicit unit") source.unit = "LB"
    if (scenario === "another page") next.box.page = 1
    if (scenario === "missing box") Object.assign(next, { box: null })
    if (scenario === "reversed boxes") next.box.bbox_2d[1] = 80
    if (scenario === "uncertain source") source.uncertain = true
    if (scenario === "uncertain next") next.uncertain = true
    if (scenario === "negative pair") source.quantity = "-4"
    if (scenario === "nonadjacent match")
      receipt.lines.splice(1, 0, {
        ...next,
        description: "OTHER ITEM",
        lineAmount: "2.00",
      })
    const invoice = normalizeFixture(receipt)
    expect(invoice.lines[0].quantity).toBe(Number(source.quantity))
    expect(invoice.lines.at(-1)?.quantity).toBe(
      next.quantity === null ? null : Number(next.quantity)
    )
    if (scenario !== "already reconciles")
      expect(invoice.lines[0].uncertain).toBe(true)
  })

  it.each(
    ["fraction", "grounding", "pixels"].flatMap((source) =>
      ["fraction", "grounding", "pixels"].flatMap((target) =>
        [false, true].map((reversed) => ({ source, target, reversed }))
      )
    )
  )(
    "compares $source and $target boxes in page space (reversed: $reversed)",
    ({ source, target, reversed }) => {
      const receipt = prefixReceipt()
      if (reversed) receipt.lines[1].box.bbox_2d = [10, 70, 900, 90]
      const pageSizes = [{ width: 2000, height: 3000 }]
      for (const [index, frame] of [source, target].entries()) {
        const values = receipt.lines[index].box.bbox_2d
        receipt.lines[index].box.bbox_2d = values.map((value, axis) =>
          frame === "grounding"
            ? value
            : (value / 1000) *
              (frame === "pixels" ? (axis % 2 ? 3000 : 2000) : 1)
        )
      }
      const result = normalizeInvoiceExtraction(
        invoiceExtractionSchema.parse(receipt),
        "USD",
        pageSizes
      )
      if ("error" in result) throw new Error(result.error)
      expect(result.lines.map((line) => line.quantity)).toEqual(
        reversed ? [4, null] : [null, 4]
      )
    }
  )

  it("flags a misplaced price prefix even when an inferred unit price conceals the mismatch", () => {
    const receipt = prefixReceipt()
    Object.assign(receipt.lines[0], { packSize: "4 @ 1.50", unitPrice: "1.37" })
    receipt.lines[1].quantity = "1"
    const invoice = normalizeFixture(receipt)
    expect(invoice.lines[0].reason).toContain("printed quantity and price")
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(0, { supplierItem: CARROT_ITEM })] })
    )
    expect(result.lines[0].match.kind).toBe("review")
  })

  it("does not carry a receipt's tax flag into the unit", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [{ ...CREAM_LINE, unit: "F" }],
    })
    expect(invoice.lines[0].unit).toBe("")
  })

  it("normalizes the Baldor fixture end to end", () => {
    const invoice = normalizeFixture(baldorInvoice)
    expect(invoice.supplier).toBe("baldor")
    expect(invoice.supplierName).toBe("Baldor Specialty Foods Inc.")
    expect(invoice.invoiceNumber).toBe("IV101-0000000001")
    expect(invoice.invoiceDate).toBe("2026-01-02")
    expect(invoice.totalCents).toBe(24388)
    expect(invoice.totalsMismatch).toBeNull()
    expect(invoice.headerWarnings).toEqual([])

    const [carrots, brisket] = invoice.lines
    expect(carrots.unitPriceCents).toBe(2450)
    expect(carrots.lineAmountCents).toBe(7350)
    expect(carrots.reason).toBeNull()
    expect(brisket.quantity).toBe(12.5)

    const smudged = invoice.lines[4]
    expect(smudged.uncertain).toBe(true)
    expect(smudged.reason).toContain("smudged")
  })

  it("keeps credit-memo amounts negative and checks the total's sign", () => {
    const credit = normalizeFixture(baldorCreditMemo)
    expect(credit.totalCents).toBe(-7350)
    expect(credit.lines[0].lineAmountCents).toBe(-7350)
    expect(credit.headerWarnings).toEqual([])

    const flipped = normalizeFixture({
      ...baldorCreditMemo,
      totalAmount: "73.50",
      lines: [{ ...baldorCreditMemo.lines[0], lineAmount: "73.50" }],
    })
    expect(flipped.headerWarnings.join(" ")).toContain("negative total")
  })

  it("flags arithmetic that doesn't add up", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      totalAmount: "80.00",
      lines: [
        {
          ...baldorInvoice.lines[0],
          quantity: "3",
          unitPrice: "24.50",
          lineAmount: "80.00",
        },
      ],
    })
    expect(invoice.lines[0].reason).toContain("doesn't match")
  })

  it("flags totals that don't match the lines", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      totalAmount: "999.99",
    })
    expect(invoice.totalsMismatch).toContain("$999.99")
  })

  it("routes unreadable amounts to review instead of guessing", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [{ ...baldorInvoice.lines[0], lineAmount: "smeared" }],
    })
    expect(invoice.lines[0].lineAmountCents).toBeNull()
    expect(invoice.lines[0].reason).toContain("Couldn't read the amount")
  })

  it("reconciles tax and fees printed outside the line table", () => {
    const taxed = {
      ...baldorInvoice,
      totalAmount: "263.88",
      otherChargesAmount: "20.00",
    }
    expect(normalizeFixture(taxed).totalsMismatch).toBeNull()

    // The charge still has to be the printed one, not a licence to be off.
    const wrong = normalizeFixture({ ...taxed, otherChargesAmount: "5.00" })
    expect(wrong.totalsMismatch).toContain("tax and fees")
  })

  it("carries the printed due date, subtotal and tax across", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      dueDate: "2026-01-16",
      subtotalAmount: "231.88",
      taxAmount: "12.00",
    })
    expect(invoice.dueDate).toBe("2026-01-16")
    expect(invoice.subtotalCents).toBe(23188)
    expect(invoice.taxCents).toBe(1200)
  })

  it("reads a document that prints none of the three as null", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      dueDate: null,
      subtotalAmount: null,
      taxAmount: null,
    })
    expect(invoice.dueDate).toBeNull()
    expect(invoice.subtotalCents).toBeNull()
    expect(invoice.taxCents).toBeNull()
  })

  it("keeps tax out of the totals arithmetic, which counts other charges", () => {
    // taxAmount is the tax already inside otherChargesAmount and the printed
    // total. Adding it again would put a correct invoice $12 out.
    const invoice = normalizeFixture({
      ...baldorInvoice,
      taxAmount: "12.00",
      otherChargesAmount: null,
    })
    expect(invoice.taxCents).toBe(1200)
    expect(invoice.totalsMismatch).toBeNull()
  })

  it("refuses a due date it can't read rather than guessing one", () => {
    expect(
      normalizeFixture({ ...baldorInvoice, dueDate: "16/1/26" }).dueDate
    ).toBeNull()
  })

  it("warns when the document's currency isn't the workspace's", () => {
    const extraction = invoiceExtractionSchema.parse({
      ...baldorInvoice,
      currency: "eur",
    })
    const euro = normalizeInvoiceExtraction(extraction, "GBP")
    if ("error" in euro) throw new Error(euro.error)
    expect(euro.headerWarnings.join(" ")).toContain("priced in EUR")

    const matching = normalizeInvoiceExtraction(extraction, "EUR")
    if ("error" in matching) throw new Error(matching.error)
    expect(matching.headerWarnings).toEqual([])
  })

  it("warns about invoice dates that can't be right", () => {
    expect(
      normalizeFixture({
        ...baldorInvoice,
        invoiceDate: "2099-01-02",
      }).headerWarnings.join(" ")
    ).toContain("in the future")
    expect(
      normalizeFixture({
        ...baldorInvoice,
        invoiceDate: "2001-01-02",
      }).headerWarnings.join(" ")
    ).toContain("more than 10 years ago")
  })

  it("names the line limit instead of letting Django call the invoice malformed", () => {
    const extraction = invoiceExtractionSchema.parse({
      ...baldorInvoice,
      lines: Array.from({ length: 501 }, (_line, index) => ({
        ...baldorInvoice.lines[0],
        lineNumber: index + 1,
      })),
    })
    expect(normalizeInvoiceExtraction(extraction)).toEqual({
      error: "That invoice has 501 lines; the limit is 500.",
    })
  })

  describe("line boxes", () => {
    const boxed = (
      box: unknown,
      pageSizes?: Array<{ width: number; height: number }>
    ) => {
      const extraction = invoiceExtractionSchema.parse({
        ...baldorInvoice,
        lines: [{ ...baldorInvoice.lines[0], box }],
      })
      const result = normalizeInvoiceExtraction(
        extraction,
        undefined,
        pageSizes
      )
      if ("error" in result) throw new Error(result.error)
      return result.lines[0].box
    }

    it("keeps a box the text layer filled as fractions", () => {
      expect(boxed({ page: 1, bbox_2d: [0.1, 0.2, 0.9, 0.25] })).toEqual({
        page: 1,
        x0: 0.1,
        y0: 0.2,
        x1: 0.9,
        y1: 0.25,
      })
    })

    it("reads the model's per-mille answer as thousandths", () => {
      expect(boxed({ page: 0, bbox_2d: [100, 200, 900, 250] })).toEqual({
        page: 0,
        x0: 0.1,
        y0: 0.2,
        x1: 0.9,
        y1: 0.25,
      })
    })

    it("reads a pixel answer against the page it was measured on", () => {
      expect(
        boxed({ page: 0, bbox_2d: [120, 320, 1080, 400] }, [
          { width: 1200, height: 1600 },
        ])
      ).toEqual({ page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.25 })
    })

    it("drops a pixel answer no page size can scale", () => {
      expect(boxed({ page: 0, bbox_2d: [120, 320, 1080, 2400] })).toBeNull()
    })

    it("clamps a box that runs off the page", () => {
      expect(
        boxed({ page: 0, bbox_2d: [-20, 320, 1300, 400] }, [
          { width: 1200, height: 1600 },
        ])
      ).toEqual({ page: 0, x0: 0, y0: 0.2, x1: 1, y1: 0.25 })
    })

    it("drops a box with no area and one on a page that wasn't read", () => {
      expect(boxed({ page: 0, bbox_2d: [0.5, 0.2, 0.5, 0.9] })).toBeNull()
      expect(boxed({ page: 0, bbox_2d: [0.1, 0.9, 0.9, 0.2] })).toBeNull()
      expect(boxed({ page: -1, bbox_2d: [0.1, 0.2, 0.9, 0.25] })).toBeNull()
      expect(
        boxed({ page: 3, bbox_2d: [0.1, 0.2, 0.9, 0.25] }, [
          { width: 1200, height: 1600 },
        ])
      ).toBeNull()
    })

    it("refuses a box that isn't four numbers", () => {
      expect(() => boxed({ page: 0, bbox_2d: [0.1, 0.2, 0.9] })).toThrow()
    })

    it("offers the model no default it could take instead of a box", () => {
      const line = zodSchema(invoiceExtractionSchema).jsonSchema as {
        properties: {
          lines: { items: { properties: { box: Record<string, unknown> } } }
        }
      }
      const box = line.properties.lines.items.properties.box
      expect(box).not.toHaveProperty("default")
      expect(JSON.stringify(box)).toContain("bbox_2d")
    })

    it("carries no box when the read placed none", () => {
      expect(boxed(null)).toBeNull()
    })
  })

  it("rejects files the model marked as not usable", () => {
    const extraction = invoiceExtractionSchema.parse({
      ...baldorInvoice,
      notUsable: "This is a bank statement.",
    })
    const result = normalizeInvoiceExtraction(extraction)
    expect(result).toHaveProperty("error")
  })
})

describe("storedDriveDocumentSchema", () => {
  function storedDocument() {
    const invoice = normalizeFixture(baldorInvoice)
    return {
      ...invoice,
      fileName: "invoice.pdf",
      driveWebViewLink: "https://drive.google.com/file/d/drive-1/view",
      extractionModel: "text-layer",
      escalated: false,
    }
  }

  it("reads a row the watcher stored before the read was kept", () => {
    const parsed = storedDriveDocumentSchema.parse(storedDocument())
    expect(parsed.extraction).toBeNull()
  })

  it("reads a row that carries the read", () => {
    const extraction = invoiceExtractionSchema.parse(baldorInvoice)
    const parsed = storedDriveDocumentSchema.parse({
      ...storedDocument(),
      extraction,
    })
    expect(parsed.extraction).toEqual(extraction)
  })

  it("reads a row stored with the fraction box the model was asked for before bbox_2d", () => {
    const legacy = { page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.25 }
    const document = storedDocument()
    const extraction = invoiceExtractionSchema.parse(baldorInvoice)
    const parsed = storedDriveDocumentSchema.parse({
      ...document,
      lines: document.lines.map((line) => ({
        ...line,
        raw: { ...line.raw, box: legacy },
      })),
      extraction: {
        ...extraction,
        lines: extraction.lines.map((line) => ({ ...line, box: legacy })),
      },
    })
    const carried = { page: 0, bbox_2d: [0.1, 0.2, 0.9, 0.25] }
    expect(parsed.lines[0].raw.box).toEqual(carried)
    expect(parsed.extraction?.lines[0].box).toEqual(carried)
  })

  it("reads a row stored before boxes were read at all", () => {
    const document = storedDocument()
    const parsed = storedDriveDocumentSchema.parse({
      ...document,
      lines: document.lines.map((line) => {
        const { box, ...raw } = line.raw
        void box
        return { ...line, raw }
      }),
    })
    expect(parsed.lines[0].raw.box).toBeNull()
  })

  it("reads a row stored before due date, subtotal and tax were kept", () => {
    const { dueDate, subtotalCents, taxCents, ...older } = storedDocument()
    void dueDate
    void subtotalCents
    void taxCents
    const parsed = storedDriveDocumentSchema.parse(older)
    expect(parsed.dueDate).toBeNull()
    expect(parsed.subtotalCents).toBeNull()
    expect(parsed.taxCents).toBeNull()
  })
})

describe("supplierItemKey", () => {
  it("agrees with the Python twin on the shared cases", () => {
    for (const item of itemKeyCases.cases) {
      expect(supplierItemKey(item.sku, item.description)).toBe(item.key)
    }
  })
})

describe("buildInvoiceParseResult", () => {
  it("carries the raw read through to the result", () => {
    const extraction = invoiceExtractionSchema.parse(baldorInvoice)
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      { ...FILE, extraction },
      invoice,
      emptyStatus()
    )
    expect(result.extraction).toEqual(extraction)
  })

  it("stamps known SKUs as updates with the stored pack", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [statusItem(0, { supplierItem: CARROT_ITEM })],
      })
    )
    const carrots = result.lines[0]
    expect(carrots.categoryId).toBe("cat-ing")
    expect(carrots.match.kind).toBe("update")
    if (carrots.match.kind !== "update") throw new Error("expected update")
    expect(carrots.match.supplierItemId).toBe("item-car10")
    expect(carrots.match.cost.packPriceCents).toBe(2450)
    expect(carrots.match.cost.packAmount).toBe(24)
    expect(carrots.match.cost.preferred).toBe(true)
    expect(carrots.match.cost.name).toBe("Carrots baby orange")
  })

  it("routes pack-size changes to review", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [{ ...baldorInvoice.lines[0], packSize: "10 X 1 LB" }],
    })
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(0, { supplierItem: CARROT_ITEM })] })
    )
    const carrots = result.lines[0]
    expect(carrots.match.kind).toBe("review")
    if (carrots.match.kind !== "review") throw new Error("expected review")
    expect(carrots.match.reason).toContain("Pack size changed")
    expect(carrots.match.suggestedPackAmount).toBe(10)
  })

  it("holds a pack whose unit changed for review", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [
        { ...baldorInvoice.lines[0], unit: "CS", packSize: "24 X 1 GAL" },
      ],
    })
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(0, { supplierItem: CARROT_ITEM })] })
    )
    const carrots = result.lines[0]
    expect(carrots.match.kind).toBe("review")
    if (carrots.match.kind !== "review") throw new Error("expected review")
    expect(carrots.match.reason).toBe("Pack unit changed from lb to gal.")
    expect(carrots.match.suggestedPackUnit).toBe("gal")
  })

  it("leaves a catch-weight line out of the pack comparison", () => {
    // The U/M prices the line by the pound, so the stored 24 lb case is not
    // what this line bought and nothing has drifted.
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [{ ...baldorInvoice.lines[0], unit: "LB", packSize: "1 LB" }],
    })
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(0, { supplierItem: CARROT_ITEM })] })
    )
    const carrots = result.lines[0]
    expect(carrots.match.kind).toBe("update")
    if (carrots.match.kind !== "update") throw new Error("expected update")
    expect(carrots.match.cost.packAmount).toBe(1)
    expect(carrots.match.cost.packUnit).toBe("lb")
  })

  it("costs a volume and a count pack in the unit they were bought by", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [
        {
          ...baldorInvoice.lines[2],
          sku: "bev1",
          description: "CLUB SODA",
          unit: "CS",
          packSize: "24 X 150 ML",
        },
        {
          ...baldorInvoice.lines[2],
          lineNumber: 2,
          sku: "sca1",
          description: "SCALLIONS",
          unit: "CS",
          packSize: "4X12 CT",
        },
      ],
      totalAmount: null,
    })
    const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
    const packs = result.lines.map((line) =>
      line.match.kind === "new"
        ? [
            line.match.cost.packAmount,
            line.match.cost.packUnit,
            line.match.cost.packGrams,
          ]
        : line.match.kind
    )
    expect(packs).toEqual([
      [3600, "ml", null],
      [48, "each", null],
    ])
  })

  it("prices a per-gallon and a per-each line as a one-unit pack", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [
        { ...CREAM_LINE, unit: "GAL", quantity: "2", lineAmount: "5.98" },
        {
          ...CREAM_LINE,
          lineNumber: 2,
          description: "LEMONS",
          unit: "EA",
          quantity: "2",
          lineAmount: "5.98",
        },
      ],
      totalAmount: null,
    })
    const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
    const packs = result.lines.map((line) =>
      line.match.kind === "new"
        ? [
            line.match.cost.packAmount,
            line.match.cost.packUnit,
            line.match.cost.packGrams,
          ]
        : line.match.kind
    )
    expect(packs).toEqual([
      [1, "gal", null],
      [1, "each", null],
    ])
  })

  it("costs catch-weight lines as a one-unit pack", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [
          statusItem(1, {
            supplierItem: {
              ...CARROT_ITEM,
              id: "item-brisket",
              ingredientId: "ing-brisket",
              ingredientName: "Corned beef brisket",
              title: "Corned beef brisket",
              rawSize: "PER LB",
              packAmount: 1,
              packUnit: "lb",
              packGrams: 454,
            },
          }),
        ],
      })
    )
    const brisket = result.lines[1]
    expect(brisket.match.kind).toBe("update")
    if (brisket.match.kind !== "update") throw new Error("expected update")
    expect(brisket.match.cost.packAmount).toBe(1)
    expect(brisket.match.cost.packUnit).toBe("lb")
    expect(brisket.match.cost.packPriceCents).toBe(899)
  })

  it("stamps unknown SKUs with a readable pack as new, prefilled from aliases", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [
          statusItem(2, {
            matchedIngredientId: "ing-cayenne",
            matchedIngredientName: "Cayenne pepper",
          }),
        ],
      })
    )
    const cayenne = result.lines[2]
    expect(cayenne.match.kind).toBe("new")
    if (cayenne.match.kind !== "new") throw new Error("expected new")
    expect(cayenne.match.cost.name).toBe("Cayenne pepper")
    expect(cayenne.match.cost.ingredientId).toBe("ing-cayenne")
    expect(cayenne.match.cost.packAmount).toBe(96)
    expect(cayenne.match.cost.packUnit).toBe("oz")
    expect(cayenne.match.cost.packPriceCents).toBe(4200)
  })

  it("keys a code-less line off its description and costs it as new", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [CREAM_LINE],
      totalAmount: "6.04",
    })
    expect(invoice.lines[0].itemKey).toBe("desc:og hvy whp crm uht")
    const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
    const cream = result.lines[0]
    expect(cream.match.kind).toBe("new")
    if (cream.match.kind !== "new") throw new Error("expected new")
    expect(cream.match.cost.packAmount).toBe(1)
    expect(cream.match.cost.packUnit).toBe("lb")
    expect(cream.match.cost.packPriceCents).toBe(299)
  })

  it("updates the price of a code-less item the merchant confirmed once", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [CREAM_LINE],
      totalAmount: "6.04",
    })
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [
          statusItem(0, {
            supplierItem: {
              ...CARROT_ITEM,
              id: "item-cream",
              ingredientId: "ing-cream",
              ingredientName: "Heavy whipping cream",
              title: "Heavy whipping cream",
              rawSize: "PER LB",
              packAmount: 1,
              packUnit: "lb",
              packGrams: 454,
            },
          }),
        ],
      })
    )
    const cream = result.lines[0]
    expect(cream.match.kind).toBe("update")
    if (cream.match.kind !== "update") throw new Error("expected update")
    expect(cream.match.supplierItemId).toBe("item-cream")
    expect(cream.match.cost.packPriceCents).toBe(299)
  })

  it("prices a receipt line that prints an amount and no quantity", () => {
    // Most Wegmans lines read "CASHEWS ROASTED 1 LB   7.99": one of the thing,
    // with the count left implicit. Resolve has to open with that price.
    const invoice = normalizeFixture({
      ...baldorInvoice,
      documentType: "receipt",
      lines: [
        {
          ...CREAM_LINE,
          description: "CASHEWS ROASTED 1 LB",
          quantity: null,
          unit: null,
          unitPrice: null,
          lineAmount: "7.99",
        },
      ],
      totalAmount: "7.99",
    })
    const line = buildInvoiceParseResult(FILE, invoice, emptyStatus()).lines[0]
    expect(line.match.kind).toBe("review")
    if (line.match.kind !== "review") throw new Error("expected review")
    expect(line.match.suggestedPriceCents).toBe(799)
  })

  it("prefers a printed unit price to the amount on a quantity-less line", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      documentType: "receipt",
      lines: [
        {
          ...CREAM_LINE,
          description: "CASHEWS ROASTED 1 LB",
          quantity: null,
          unit: null,
          unitPrice: "3.50",
          lineAmount: "7.00",
        },
      ],
      totalAmount: "7.00",
    })
    const line = buildInvoiceParseResult(FILE, invoice, emptyStatus()).lines[0]
    expect(line.match.kind).toBe("review")
    if (line.match.kind !== "review") throw new Error("expected review")
    expect(line.match.suggestedPriceCents).toBe(350)
  })

  it("still refuses a credit line that prints no quantity", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      documentType: "receipt",
      lines: [
        {
          ...CREAM_LINE,
          description: "BOTTLE DEPOSIT REFUND",
          quantity: null,
          unit: null,
          unitPrice: null,
          lineAmount: "-2.40",
        },
      ],
      totalAmount: "-2.40",
    })
    const line = buildInvoiceParseResult(FILE, invoice, emptyStatus()).lines[0]
    expect(line.match.kind).toBe("expense-only")
    if (line.match.kind !== "expense-only") throw new Error("expected expense")
    expect(line.match.note).toContain("Credit line")
  })

  it("leaves a line with neither a code nor a readable name expense-only", () => {
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [{ ...CREAM_LINE, description: "---" }],
      totalAmount: "6.04",
    })
    expect(invoice.lines[0].itemKey).toBe("")
    const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
    const line = result.lines[0]
    expect(line.match.kind).toBe("expense-only")
    if (line.match.kind !== "expense-only") throw new Error("expected expense")
    expect(line.match.note).toContain("identifies the product")
  })

  it("sends a second pack sharing one description to review", () => {
    // Two packs of the same item share a description, so they share a key;
    // the pack-size drift check keeps the smaller one from repricing the
    // stored pack silently.
    const invoice = normalizeFixture({
      ...baldorInvoice,
      lines: [
        {
          ...CREAM_LINE,
          unit: "CS",
          packSize: "12 X 1 LB",
          quantity: "1",
          unitPrice: "36.00",
          lineAmount: "36.00",
        },
      ],
      totalAmount: "36.00",
    })
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [
          statusItem(0, { supplierItem: { ...CARROT_ITEM, id: "item-cream" } }),
        ],
      })
    )
    const cream = result.lines[0]
    expect(cream.match.kind).toBe("review")
    if (cream.match.kind !== "review") throw new Error("expected review")
    expect(cream.match.reason).toContain("Pack size changed")
  })

  it("respects the skip list", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(0, { ignored: true })] })
    )
    expect(result.lines[0].match.kind).toBe("ignored")
  })

  it("matches on the item key alone, whatever the category says", () => {
    // The fee line is tagged Other and still gets a match: the category is the
    // review step's decision, not the matcher's, so the line stays resolvable.
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(FILE, invoice, emptyStatus())
    const fuel = result.lines[3]
    expect(fuel.categoryId).toBe("cat-other")
    expect(fuel.itemKey).toBe("desc:fuel surcharge")
    expect(fuel.match.kind).toBe("review")
  })

  it("keeps every credit-memo line expense-only", () => {
    const credit = normalizeFixture(baldorCreditMemo)
    const result = buildInvoiceParseResult(
      FILE,
      credit,
      emptyStatus({ items: [statusItem(0, { supplierItem: CARROT_ITEM })] })
    )
    expect(
      result.lines.every((line) => line.match.kind === "expense-only")
    ).toBe(true)
  })

  it("sends uncertain lines to review even when the SKU is known", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ items: [statusItem(4, { supplierItem: CARROT_ITEM })] })
    )
    const smudged = result.lines[4]
    expect(smudged.match.kind).toBe("review")
  })

  it("prefers the category the user picked last time over the model's suggestion", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [statusItem(0, { lastCategoryId: "cat-staff" })],
      })
    )
    const carrots = result.lines[0]
    expect(carrots.categoryId).toBe("cat-staff")
    // Staff meal isn't costable, but the match is computed before the tagging:
    // the dialog withholds the cost entry, the matcher still proposes one.
    expect(carrots.match.kind).toBe("new")
  })

  it("still proposes a price update under a non-costable category", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({
        items: [
          statusItem(0, {
            supplierItem: CARROT_ITEM,
            lastCategoryId: "cat-other",
          }),
        ],
      })
    )
    const carrots = result.lines[0]
    expect(carrots.categoryId).toBe("cat-other")
    expect(carrots.match.kind).toBe("update")
  })

  it("passes the duplicate flag through", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ duplicate: true })
    )
    expect(result.duplicate).toBe(true)
    expect(result.existingInvoice).toBeNull()
  })

  it("carries the invoice a duplicate would repeat", () => {
    const invoice = normalizeFixture(baldorInvoice)
    const existingInvoice = {
      id: "6f1d0f6e-0000-4000-8000-000000000001",
      publicId: "inv_abc123",
      invoiceNumber: "IV101-1",
      invoiceDate: "2026-07-14",
      totalCents: 7850,
      lineCount: 2,
      importedAt: "2026-07-15T10:00:00Z",
    }
    const result = buildInvoiceParseResult(
      FILE,
      invoice,
      emptyStatus({ duplicate: true, existingInvoice })
    )
    expect(result.existingInvoice).toEqual(existingInvoice)
  })
})

describe("normalizeInvoiceExtraction on a till receipt", () => {
  const line = (
    description: string,
    values: Partial<InvoiceExtraction["lines"][number]> = {}
  ): InvoiceExtraction["lines"][number] => ({
    lineNumber: 1,
    sku: null,
    description,
    quantity: null,
    unit: null,
    packSize: null,
    unitPrice: null,
    lineAmount: null,
    suggestedCategory: null,
    uncertain: false,
    uncertainReason: null,
    box: null,
    ...values,
  })
  const receipt: InvoiceExtraction = {
    supplierName: "Wegmans",
    documentType: "receipt",
    invoiceNumber: "393962",
    invoiceDate: "2026-08-13",
    totalAmount: "19.02",
    currency: null,
    otherChargesAmount: "0.00",
    dueDate: null,
    subtotalAmount: null,
    taxAmount: null,
    notUsable: null,
    lines: [
      line("OG HVY WHP CRM UHT", {
        quantity: "2",
        unitPrice: "6.49",
        lineAmount: "12.98",
      }),
      line("YELLOW PEACH", {
        quantity: "2.02",
        unit: "lb",
        unitPrice: "2.99",
        lineAmount: "6.04",
      }),
      line("TAX", { unitPrice: "0.00", lineAmount: "0.00" }),
      line("**** BALANCE", { unitPrice: "19.02", lineAmount: "19.02" }),
      line("CREDIT CARD", { lineAmount: "19.02" }),
      line("CARD NUMBER: ************2711", { uncertain: true }),
      line("VERIFIED BY PIN", { uncertain: true }),
      line("Every day you get our best!", { uncertain: true }),
      line("CASHEWS ROASTED 1 LB", { lineAmount: "7.99" }),
    ],
  }

  it("keeps the purchases and drops the totals block, card slip and footer", () => {
    const result = normalizeInvoiceExtraction(receipt)
    if ("error" in result) throw new Error(result.error)
    expect(result.lines.map((l) => l.description)).toEqual([
      "OG HVY WHP CRM UHT",
      "YELLOW PEACH",
      "CASHEWS ROASTED 1 LB",
    ])
    expect(result.lines.map((l) => l.position)).toEqual([0, 1, 2])
    expect(result.totalsMismatch).toMatch(/26\.99|\$27\.01/)
  })

  it("drops a line that carries no quantity, price or amount", () => {
    const result = normalizeInvoiceExtraction({
      ...receipt,
      lines: [
        receipt.lines[0],
        line("Something unreadable", { uncertain: true }),
      ],
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.lines).toHaveLength(1)
  })
})

describe("multiDocumentCount", () => {
  it.each([
    ["This scan holds 15 separate receipts.", 15],
    ["The file contains 3 receipts.", 3],
    ["This photo shows two receipts side by side.", 2],
    ["Multiple invoices are printed on this page.", 0],
    ["This is a restaurant menu, not a purchase document.", null],
    ["This is a bank statement.", null],
  ])("reads %s as %s", (reason, count) => {
    expect(multiDocumentCount(reason)).toBe(count)
  })
})

describe("bundleRefusal", () => {
  it("tells a cook holding a phone what to do", () => {
    expect(bundleRefusal(3, "photo")).toBe(
      "This photo shows 3 receipts and they could not be separated — take one photo per receipt."
    )
  })

  it("names the file, not the camera, for a scan", () => {
    expect(bundleRefusal(15, "scan")).toBe(
      "This scan holds 15 receipts and they could not be separated — save one file per receipt."
    )
  })

  it("says 'several' when the reader never counted them", () => {
    expect(bundleRefusal(0, "photo")).toContain("several receipts")
  })
})
