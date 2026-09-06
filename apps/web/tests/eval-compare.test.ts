import { describe, expect, it } from "vitest"

import type { InvoiceExtraction } from "@/lib/invoice-import"
import { compareExtraction, summarize } from "../scripts/eval/compare"

import baldorInvoice from "./fixtures/invoices/baldor-invoice.json"

const golden = baldorInvoice as InvoiceExtraction

describe("compareExtraction", () => {
  it("scores an identical read as fully correct", () => {
    const result = compareExtraction(golden, golden)
    expect(result.fullyCorrect).toBe(true)
    expect(result.headerFieldAccuracy).toBe(1)
    expect(result.lineFieldAccuracy).toBe(1)
  })

  it("ignores cosmetic differences the importer normalizes away", () => {
    const read: InvoiceExtraction = {
      ...golden,
      supplierName: "BALDOR SPECIALTY FOODS",
      totalAmount: "$243.88",
      otherChargesAmount: "0.00",
      lines: golden.lines.map((line) => ({
        ...line,
        sku: line.sku?.toLowerCase() ?? null,
        description: `${line.description.toLowerCase()}.`,
        quantity: /^\d+$/.test(line.quantity ?? "")
          ? `${line.quantity}.0`
          : line.quantity,
      })),
    }
    const result = compareExtraction(golden, read)
    const misses = [...result.header, ...result.lines.flatMap((l) => l.fields)]
      .filter((f) => !f.ok)
      .map((f) => `${f.field}: ${f.expected} vs ${f.actual}`)
    expect(misses).toEqual([])
    expect(result.fullyCorrect).toBe(true)
  })

  it("names the field that differs and the line it is on", () => {
    const read: InvoiceExtraction = {
      ...golden,
      lines: golden.lines.map((line, index) =>
        index === 1 ? { ...line, unitPrice: "99.99" } : line
      ),
    }
    const result = compareExtraction(golden, read)
    expect(result.fullyCorrect).toBe(false)
    expect(result.lines[1].ok).toBe(false)
    const miss = result.lines[1].fields.find((f) => !f.ok)
    expect(miss?.field).toBe("unitPrice")
    expect(result.lines[0].ok).toBe(true)
  })

  it("fails a read with a different number of lines", () => {
    const read = { ...golden, lines: golden.lines.slice(0, -1) }
    const result = compareExtraction(golden, read)
    expect(result.lineCountMatches).toBe(false)
    expect(result.fullyCorrect).toBe(false)
    expect(result.lines.at(-1)?.ok).toBe(false)
  })

  it("skips due date, subtotal and tax a golden file hasn't stated", () => {
    // On those three alone, null means "not hand-verified", so a golden file
    // written before the field existed does not start failing every read.
    const unstated: InvoiceExtraction = {
      ...golden,
      dueDate: null,
      subtotalAmount: null,
      taxAmount: null,
    }
    const read: InvoiceExtraction = {
      ...unstated,
      dueDate: "2026-01-16",
      subtotalAmount: "231.88",
      taxAmount: "12.00",
    }
    const result = compareExtraction(unstated, read)
    expect(result.header.map((f) => f.field)).not.toContain("dueDate")
    expect(result.header.map((f) => f.field)).not.toContain("subtotalAmount")
    expect(result.header.map((f) => f.field)).not.toContain("taxAmount")
    expect(result.fullyCorrect).toBe(true)
  })

  it("scores the three once the golden file states them", () => {
    // The checked-in fixture states all three, so a read that differs misses.
    expect(compareExtraction(golden, golden).fullyCorrect).toBe(true)
    const read = { ...golden, taxAmount: "12.00" }
    const result = compareExtraction(golden, read)
    expect(result.fullyCorrect).toBe(false)
    expect(result.header.find((f) => !f.ok)?.field).toBe("taxAmount")
  })

  it("scores a not-usable document on the verdict alone", () => {
    const bundle: InvoiceExtraction = {
      ...golden,
      lines: [],
      notUsable: "Fifteen receipts in one file",
    }
    expect(compareExtraction(bundle, bundle).fullyCorrect).toBe(true)
    expect(compareExtraction(bundle, golden).fullyCorrect).toBe(false)
    expect(compareExtraction(golden, bundle).header[0]).toMatchObject({
      field: "notUsable",
      ok: false,
    })
  })
})

describe("summarize", () => {
  it("aggregates rates, cost and failures", () => {
    const ok = compareExtraction(golden, golden)
    const bad = compareExtraction(golden, { ...golden, lines: [] })
    const summary = summarize([
      {
        name: "a",
        comparison: ok,
        reconciled: true,
        escalated: false,
        error: null,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.02,
        ms: 100,
      },
      {
        name: "b",
        comparison: bad,
        reconciled: false,
        escalated: true,
        error: null,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.04,
        ms: 300,
      },
      {
        name: "c",
        comparison: null,
        reconciled: false,
        escalated: false,
        error: "boom",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        ms: 50,
      },
    ])
    expect(summary).toMatchObject({
      documents: 3,
      failed: 1,
      fullyCorrect: 1,
      reconciledRate: 0.5,
      meanMs: 150,
    })
    expect(summary.fullyCorrectRate).toBeCloseTo(1 / 3)
    expect(summary.escalatedRate).toBeCloseTo(1 / 3)
    expect(summary.costUsd).toBeCloseTo(0.06)
  })
})
