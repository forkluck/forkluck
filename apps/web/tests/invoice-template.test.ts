import { describe, expect, it } from "vitest"

import {
  invoiceExtractionSchema,
  normalizeInvoiceExtraction,
} from "../lib/invoice-import"
import {
  parseInvoiceFromTextLines,
  type TemplateLine,
} from "../lib/invoice-template"

/** US Letter, as pdf.js reports it for the real Baldor invoices. */
const PAGE = { width: 612, height: 792 }
const LINE_HEIGHT = 10
const LINE_SPACING = 18
const TOP_MARGIN = 60
/** Helvetica 10pt is about 6pt per character — close enough to give each item
 * a width, which is what the right edge of a line's box is measured from. */
const CHAR_WIDTH = 6

function line(...items: Array<[number, string]>): TemplateLine {
  const ordered = items.map(([x, text]) => ({
    x,
    width: text.length * CHAR_WIDTH,
    text,
  }))
  return {
    text: ordered.map((item) => item.text).join(" "),
    items: ordered,
    page: 0,
    y: PAGE.height - TOP_MARGIN,
    height: LINE_HEIGHT,
  }
}

/** Stack lines down one page the way a real read finds them: first line at the
 * top, PDF y measured upward from the bottom. */
function stacked(lines: TemplateLine[]): TemplateLine[] {
  return lines.map((row, index) => ({
    ...row,
    y: PAGE.height - TOP_MARGIN - index * LINE_SPACING,
  }))
}

// Synthetic column anchors exercise quantity fields on the left,
// item descriptions in the middle, and monetary fields on the right.
const HEADER = line(
  [40, "Ordered"],
  [80, "Shipped"],
  [120, "B.O."],
  [150, "U/M"],
  [190, "Item"],
  [260, "Item"],
  [285, "Description"],
  [430, "Origin"],
  [470, "Unit"],
  [490, "Price"],
  [540, "Extended Price"]
)

function baldorPage(overrides?: {
  rows?: TemplateLine[]
  total?: string
  number?: string
}): TemplateLine[] {
  const rows = overrides?.rows ?? [
    line(
      [45, "3"],
      [85, "3"],
      [150, "CS"],
      [190, "TEST-CARROT"],
      [260, "CARROTS"],
      [300, "BABY ORANGE"],
      [430, "USA"],
      [470, "24.50"],
      [540, "73.50"]
    ),
    line(
      [45, "12.5"],
      [85, "12.5"],
      [150, "LB"],
      [190, "TEST-PROTEIN"],
      [260, "TEST PROTEIN"],
      [430, "USA"],
      [470, "8.99"],
      [540, "112.38"]
    ),
    line([190, "FUEL"], [260, "FUEL SURCHARGE"], [540, "6.00"]),
  ]
  return stacked([
    line([40, "Please Mail Payment To:"]),
    line([40, "Baldor Specialty Foods Inc."]),
    line([400, "Invoice"], [470, overrides?.number ?? "IV101-0000000002"]),
    line([400, "Invoice Date"], [470, "1/2/2026"]),
    HEADER,
    ...rows,
    line([400, "Invoice Total"], [540, overrides?.total ?? "191.88"]),
  ])
}

// A synthetic layout covering merged header labels ("Item Description", "Unit
// Price"), "B.O" without a trailing dot, "Total Invoice" wording, and packs
// embedded in descriptions. It contains no customer or vendor document data.
function syntheticBaldorPage(): TemplateLine[] {
  return stacked([
    line(
      [186, "Please Mail Payment To:"],
      [449, "Invoice"],
      [518, "IV101-0000000003"]
    ),
    line(
      [186, "Baldor Specialty Foods Inc."],
      [449, "Customer"],
      [514, "CU101-0000000001"]
    ),
    line(
      [186, "The perishable agricultural commodities listed on this invoice…"],
      [448, "Invoice Date"],
      [559, "6/2/2026"]
    ),
    line([449, "Date and time"], [524, "06/01/2026 18:33"]),
    line(
      [25, "Ordered"],
      [70, "Shipped"],
      [114, "B.O"],
      [146, "U/M"],
      [178, "Item"],
      [225, "Item Description"],
      [450, "Origin"],
      [487, "Unit Price"],
      [533, "Extended Price"]
    ),
    line(
      [45, "1.00"],
      [90, "1.00"],
      [119, "0.00"],
      [145, "CTN"],
      [172, "TEST-BUTTER"],
      [231, "BUTTER UNSALTED 82% 36X1 LB"],
      [445, "USA"],
      [501, "108.45"],
      [566, "108.45"]
    ),
    line(
      [45, "1.00"],
      [90, "1.00"],
      [119, "0.00"],
      [145, "CTN"],
      [172, "TEST-SCALLION"],
      [231, "SCALLIONS 48 CT (4X12 CT)"],
      [445, "MEX"],
      [505, "28.25"],
      [571, "28.25"]
    ),
    line(
      [45, "2.00"],
      [90, "2.00"],
      [119, "0.00"],
      [142, "EACH"],
      [172, "TEST-NUT"],
      [231, "NUTS HALVES 2.5 LB"],
      [445, "USA"],
      [505, "24.39"],
      [571, "48.78"]
    ),
    line(
      [45, "1.00"],
      [90, "1.00"],
      [119, "0.00"],
      [145, "CTN"],
      [172, "TEST-TOMATO"],
      [231, "TOMATO 5X6 25 LB"],
      [445, "USA"],
      [505, "34.50"],
      [571, "34.50"]
    ),
    line([416, "Nontaxable SubTotal"], [557, "219.98"]),
    line([416, "Tax"], [566, "0.00"]),
    line(
      [40, "Received by___________________"],
      [416, "Total Invoice"],
      [556, "219.98"]
    ),
  ])
}

describe("parseInvoiceFromTextLines (synthetic Baldor geometry)", () => {
  it("parses the representative invoice layout end to end", () => {
    const result = parseInvoiceFromTextLines([syntheticBaldorPage()], [PAGE])
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.invoiceNumber).toBe("IV101-0000000003")
    expect(result.invoiceDate).toBe("2026-06-02")
    expect(result.totalAmount).toBe("219.98")
    expect(result.lines).toHaveLength(4)

    const [butter, scallions, walnuts, tomato] = result.lines
    // B.O ("0.00") must not bleed into the U/M column.
    expect(butter.unit).toBe("CTN")
    expect(walnuts.unit).toBe("EACH")
    // Packs come out of the descriptions; count-based packs stay null so the
    // line lands in review instead of being guessed.
    expect(butter.packSize).toBe("36X1 LB")
    expect(walnuts.packSize).toBe("2.5 LB")
    expect(tomato.packSize).toBe("25 LB")
    expect(scallions.packSize).toBe("4X12 CT")
    expect(butter.sku).toBe("TEST-BUTTER")
    expect(butter.quantity).toBe("1.00")
    expect(butter.unitPrice).toBe("108.45")
    // The totals block, read for the record and not for the arithmetic.
    expect(result.subtotalAmount).toBe("219.98")
    expect(result.taxAmount).toBe("0.00")
    expect(result.dueDate).toBeNull()
  })

  it("places every emitted line on the page it was read from", () => {
    const result = parseInvoiceFromTextLines([syntheticBaldorPage()], [PAGE])
    if (!result) throw new Error("expected a parse")

    // The first item row is the sixth line down a US Letter page: baseline
    // 642pt up from the bottom, 10pt tall, from x=45 to x=566+36.
    expect(result.lines[0].box).toEqual({
      page: 0,
      bbox_2d: [45 / 612, 1 - 652 / 792, 602 / 612, 1 - 639.5 / 792],
    })
    // Upper half of the page, spanning nearly its full width.
    const [x0, , x1, y1] = result.lines[0].box!.bbox_2d
    expect(y1).toBeLessThan(0.5)
    expect(x1 - x0).toBeGreaterThan(0.8)
    // Each later row sits below the one above it and never leaves the page.
    for (const [index, line] of result.lines.entries()) {
      expect(line.box).not.toBeNull()
      expect(line.box!.page).toBe(0)
      const [, top, , bottom] = line.box!.bbox_2d
      expect(top).toBeGreaterThanOrEqual(0)
      expect(bottom).toBeLessThanOrEqual(1)
      if (index > 0) {
        expect(top).toBeGreaterThan(result.lines[index - 1].box!.bbox_2d[1])
      }
    }
  })

  it("leaves boxes off when the read reported no page size", () => {
    const result = parseInvoiceFromTextLines([syntheticBaldorPage()])
    expect(result?.lines.every((line) => line.box === null)).toBe(true)
  })

  it("survives normalization with no review flags", () => {
    const extraction = invoiceExtractionSchema.parse(
      parseInvoiceFromTextLines([syntheticBaldorPage()], [PAGE])
    )
    const normalized = normalizeInvoiceExtraction(extraction)
    expect(normalized).not.toHaveProperty("error")
    if ("error" in normalized) return
    expect(normalized.totalCents).toBe(21998)
    expect(normalized.totalsMismatch).toBeNull()
    expect(normalized.lines.every((row) => row.reason === null)).toBe(true)
  })
})

describe("parseInvoiceFromTextLines (Baldor template)", () => {
  it("parses a standard invoice with no AI involved", () => {
    const result = parseInvoiceFromTextLines([baldorPage()], [PAGE])
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.supplierName).toContain("Baldor")
    expect(result.documentType).toBe("invoice")
    expect(result.invoiceNumber).toBe("IV101-0000000002")
    expect(result.invoiceDate).toBe("2026-01-02")
    expect(result.totalAmount).toBe("191.88")
    expect(result.lines).toHaveLength(3)

    const [carrots, brisket, fuel] = result.lines
    expect(carrots.sku).toBe("TEST-CARROT")
    expect(carrots.description).toBe("CARROTS BABY ORANGE")
    expect(carrots.quantity).toBe("3")
    expect(carrots.unit).toBe("CS")
    expect(carrots.unitPrice).toBe("24.50")
    expect(carrots.lineAmount).toBe("73.50")
    expect(carrots.suggestedCategory).toBe("Ingredients")
    expect(brisket.unit).toBe("LB")
    expect(fuel.suggestedCategory).toBe("Other")
  })

  it("puts the first item row in the upper half, across most of the width", () => {
    const result = parseInvoiceFromTextLines([baldorPage()], [PAGE])
    expect(result?.lines[0].box).toEqual({
      page: 0,
      bbox_2d: [45 / 612, 1 - 652 / 792, 570 / 612, 1 - 639.5 / 792],
    })
  })

  it("feeds the exact shape the rest of the pipeline expects", () => {
    const result = parseInvoiceFromTextLines([baldorPage()], [PAGE])
    const extraction = invoiceExtractionSchema.parse(result)
    const normalized = normalizeInvoiceExtraction(extraction)
    expect(normalized).not.toHaveProperty("error")
    if ("error" in normalized) return
    expect(normalized.supplier).toBe("baldor")
    expect(normalized.totalCents).toBe(19188)
    expect(normalized.totalsMismatch).toBeNull()
    expect(normalized.lines.every((row) => row.reason === null)).toBe(true)
  })

  it("recognizes credit memos with parenthesized amounts", () => {
    const page = baldorPage({
      number: "CR101-0000000002",
      total: "(73.50)",
      rows: [
        line(
          [45, "-3"],
          [85, "-3"],
          [150, "CS"],
          [190, "TEST-CARROT"],
          [260, "CARROTS RETURNED"],
          [470, "24.50"],
          [540, "(73.50)"]
        ),
      ],
    })
    const result = parseInvoiceFromTextLines([page], [PAGE])
    expect(result?.documentType).toBe("credit_memo")
    expect(result?.totalAmount).toBe("(73.50)")
    expect(result?.lines[0].lineAmount).toBe("(73.50)")
  })

  it("reconciles a sales tax printed in the totals block", () => {
    const page = baldorPage()
    // Sales tax sits outside the item table, so without it the printed total
    // can never match the lines and a correct invoice would defer to the AI.
    page.splice(page.length - 1, 0, line([400, "Sales Tax"], [540, "8.12"]))
    page[page.length - 1] = line([400, "Invoice Total"], [540, "200.00"])
    const result = parseInvoiceFromTextLines([page], [PAGE])
    expect(result?.otherChargesAmount).toBe("8.12")
    expect(result?.totalAmount).toBe("200.00")
    // The same $8.12, reported again as tax — it is not a second charge.
    expect(result?.taxAmount).toBe("8.12")
  })

  it("reads the printed totals block: two subtotal halves and the tax", () => {
    // Baldor's layout, right down to the boilerplate sharing the label's line.
    const page = baldorPage()
    page.splice(
      page.length - 1,
      0,
      line(
        [40, "EXCEPT MEATS AND CHEESES. THESE"],
        [400, "Nontaxable SubTotal"],
        [540, "150.00"]
      ),
      line([400, "Taxable SubTotal"], [540, "41.88"]),
      line(
        [40, "Total reflects a cash-discounted price; other payment"],
        [400, "Tax"],
        [540, "0.00"]
      )
    )
    const result = parseInvoiceFromTextLines([page], [PAGE])
    expect(result?.subtotalAmount).toBe("191.88")
    expect(result?.taxAmount).toBe("0.00")
    // Baldor prints payment terms, never a due date, and one is never computed.
    expect(result?.dueDate).toBeNull()
  })

  it("reads a printed due date, and only a printed one", () => {
    const page = baldorPage()
    page.splice(4, 0, line([400, "Due Date"], [470, "1/16/2026"]))
    expect(parseInvoiceFromTextLines([page], [PAGE])?.dueDate).toBe(
      "2026-01-16"
    )

    const terms = baldorPage()
    terms.splice(4, 0, line([400, "Terms"], [470, "Net 14"]))
    expect(parseInvoiceFromTextLines([terms], [PAGE])?.dueDate).toBeNull()
  })

  it("prints no subtotal or tax when the document prints none", () => {
    const result = parseInvoiceFromTextLines([baldorPage()], [PAGE])
    expect(result?.subtotalAmount).toBeNull()
    expect(result?.taxAmount).toBeNull()
  })

  it("defers when the lines don't add up to the printed total", () => {
    expect(
      parseInvoiceFromTextLines([baldorPage({ total: "999.99" })], [PAGE])
    ).toBeNull()
  })

  it("defers when quantity × unit price disagrees with the amount", () => {
    const page = baldorPage({
      rows: [
        line(
          [45, "3"],
          [85, "3"],
          [150, "CS"],
          [190, "TEST-CARROT"],
          [260, "CARROTS"],
          [470, "24.50"],
          [540, "80.00"]
        ),
      ],
      total: "80.00",
    })
    expect(parseInvoiceFromTextLines([page], [PAGE])).toBeNull()
  })

  it("defers on unknown suppliers and missing tables", () => {
    const stranger = [
      line([40, "Harbor Supply"]),
      line([40, "Invoice 12345"]),
      line([40, "Total"], [200, "50.00"]),
    ]
    expect(parseInvoiceFromTextLines([stranger], [PAGE])).toBeNull()

    const headerless = [baldorPage()[0], baldorPage()[1], baldorPage()[2]]
    expect(parseInvoiceFromTextLines([headerless], [PAGE])).toBeNull()
  })
})
