import { describe, expect, it } from "vitest"

import { parsePurchaseRows } from "../lib/purchase-import"

const HEADER = ["ID", "Name", "Quantity", "Size", "Paid Total"]

describe("parsePurchaseRows", () => {
  it("detects Baldor exports and keeps Current Price as the pack price", () => {
    const result = parsePurchaseRows(
      [
        ["ID", "Title", "Size", "Quantity", "Current Price"],
        ["a1", "Baby Arugula", "3 LB", 2, 17.75],
        ["a3", "Baby Arugula", "4 LB", 6, 19.25],
      ],
      { fileName: "harbor_export_2025-07-01_2026-08-06.xlsx" }
    )

    expect(result.source).toEqual({
      supplier: "baldor",
      label: "Baldor",
      periodStart: "2025-07-01",
      periodEnd: "2026-08-06",
    })
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].packPriceCents).toBe(1775)
    expect(result.entries[1].packPriceCents).toBe(1925)
    expect(result.entries[0].preferred).toBe(false)
    expect(result.entries[1].preferred).toBe(true)
  })

  it("holds zero prices for review and reads the volume pack", () => {
    const result = parsePurchaseRows([
      ["ID", "Title", "Size", "Quantity", "Current Price"],
      ["bevft6c", "Club Soda", "24 X 150 ML", 3, 21.59],
      ["be92a", "Organic Strawberries", "8 X 1 LB", 2, 0],
      ["asia1aa", "Green Curry Paste", "35 OZ", 1, 9.19],
    ])

    expect(result.entries.map((entry) => entry.externalId)).toEqual([
      "bevft6c",
      "asia1aa",
    ])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].externalId).toBe("be92a")
  })

  it("divides the paid total by the quantity purchased", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["a3", "Baby Arugula", "2", "4 LB", "37.5"],
    ])
    expect(result.skipped).toEqual([])
    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.name).toBe("Baby Arugula")
    expect(entry.packPriceCents).toBe(1875)
    expect(entry.packAmount).toBe(4)
    expect(entry.packUnit).toBe("lb")
    expect(entry.packGrams).toBe(Math.round(4 * 453.592))
  })

  it("multiplies case packs like 8 X 1 LB into a single pack size", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["be92a", "Organic Strawberries", "2", "8 X 1 LB", "206.75"],
    ])
    const entry = result.entries[0]
    expect(entry.packAmount).toBe(8)
    expect(entry.packUnit).toBe("lb")
    expect(entry.packPriceCents).toBe(10338)
  })

  it("reads 24 X 150 ML as 3600 ml and leaves it weightless", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["bev", "Club Soda", "3", "24 X 150 ML", "64.17"],
      ["bo1i", "Raspberry Puree", "1", "1 KG", "22.39"],
    ])
    expect(result.skipped).toEqual([])
    expect(result.entries).toHaveLength(2)
    const soda = result.entries[0]
    expect(soda.packAmount).toBe(3600)
    expect(soda.packUnit).toBe("ml")
    expect(soda.packGrams).toBeNull()
  })

  it("multiplies a count pack and files every container word under each", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["s1", "Scallions", "1", "4X12 CT", "28.00"],
      ["s2", "Eggs", "1", "15 DZ", "45.00"],
      ["s3", "Napkins", "1", "6 CS", "12.00"],
    ])
    expect(result.skipped).toEqual([])
    expect(
      result.entries.map((entry) => [entry.packAmount, entry.packUnit])
    ).toEqual([
      [48, "each"],
      [15, "dozen"],
      [6, "each"],
    ])
    expect(result.entries.every((entry) => entry.packGrams === null)).toBe(true)
  })

  it("reads FL OZ as a volume and OZ as a weight", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["v1", "Vanilla", "1", "32 FL OZ", "40.00"],
      ["v2", "Curry Paste", "1", "32 OZ", "9.19"],
    ])
    expect(
      result.entries.map((entry) => [entry.packUnit, entry.packGrams])
    ).toEqual([
      ["fl-oz", null],
      ["oz", Math.round(32 * 28.349523125)],
    ])
  })

  it("keeps the last row when the same item appears twice", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["x1", "Butter", "1", "1 LB", "5.00"],
      ["x2", "Butter", "2", "1 LB", "9.00"],
    ])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].packPriceCents).toBe(450)
  })

  it("skips rows with unreadable quantity or price", () => {
    const result = parsePurchaseRows([
      HEADER,
      ["x1", "Ghost Pepper", "?", "1 LB", "5.00"],
      ["x2", "Salt", "1", "1 KG", ""],
    ])
    expect(result.entries).toEqual([])
    expect(result.skipped).toHaveLength(2)
  })

  it("reports a missing header row", () => {
    const result = parsePurchaseRows([["just", "some", "cells"]])
    expect(result.entries).toEqual([])
    expect(result.skipped[0].reason).toContain("header")
  })
})
