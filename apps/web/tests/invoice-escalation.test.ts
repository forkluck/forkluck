import { describe, expect, it } from "vitest"

import {
  chooseExtraction,
  escalationHint,
  extractionFindings,
  needsEscalation,
} from "@/lib/invoice-escalation"
import {
  normalizeInvoiceExtraction,
  type InvoiceExtraction,
  type NormalizedInvoice,
} from "@/lib/invoice-import"

import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"

// The checked-in fixture carries one deliberately uncertain line; clear it so
// the baseline here reconciles and each test adds exactly the flaws it names.
const fixture: InvoiceExtraction = {
  ...(baldorInvoice as InvoiceExtraction),
  lines: (baldorInvoice as InvoiceExtraction).lines.map((line) => ({
    ...line,
    uncertain: false,
    uncertainReason: null,
  })),
}

function normalized(patch: Partial<InvoiceExtraction> = {}): NormalizedInvoice {
  const result = normalizeInvoiceExtraction({ ...fixture, ...patch })
  if ("error" in result) throw new Error(result.error)
  return result
}

describe("extractionFindings", () => {
  it("is empty for a document that reconciles", () => {
    expect(extractionFindings(normalized())).toEqual([])
    expect(needsEscalation(normalized())).toBe(false)
  })

  it("lists the total, the date, the arithmetic and each uncertain line", () => {
    const findings = extractionFindings(
      normalized({
        invoiceDate: null,
        totalAmount: "999.99",
        lines: fixture.lines.map((line, index) =>
          index === 0
            ? { ...line, uncertain: true, uncertainReason: "Smudged" }
            : line
        ),
      })
    )
    expect(findings).toHaveLength(3)
    expect(findings[0]).toBe("The invoice date could not be read.")
    expect(findings[1]).toMatch(/invoice total reads \$999\.99/)
    expect(findings[2]).toBe(
      `Line 1 "${fixture.lines[0].description}": Smudged`
    )
  })
})

describe("chooseExtraction", () => {
  it("keeps the first read when the escalation is worse", () => {
    const first = normalized()
    const worse = normalized({ totalAmount: null })
    expect(chooseExtraction(first, worse)).toEqual({
      chosen: first,
      pick: "first",
    })
  })

  it("prefers the escalation when it reconciles or ties", () => {
    const flawed = normalized({ totalAmount: "1.00" })
    const clean = normalized()
    expect(chooseExtraction(flawed, clean).pick).toBe("escalation")
    expect(chooseExtraction(clean, normalized()).pick).toBe("escalation")
  })
})

describe("escalationHint", () => {
  it("quotes every finding as a bullet", () => {
    const hint = escalationHint(["A", "B"])
    expect(hint).toContain("- A\n- B")
    expect(hint).toMatch(/null rather than guessing/)
  })
})
