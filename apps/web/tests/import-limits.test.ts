import { describe, expect, it, vi } from "vitest"
import * as XLSX from "xlsx"

import {
  ARCHIVE_LIMITS,
  ImportTooComplexError,
  SHEET_LIMITS,
  assertArchiveWithinBudget,
  complexityMessage,
  readFirstSheetRows,
} from "@/lib/import-limits"

/**
 * Complexity ceilings on what an upload *expands into*.
 *
 * The encoded payload was capped at 8M base64 characters, but that bounds the
 * compressed size only. XLSX is a zip: a tiny upload can declare a worksheet
 * with millions of cells, and `sheet_to_json` materializes all of it before
 * anything can refuse it. These cases pin that the refusal happens from the
 * declared range, without the expansion.
 */

// `server-only` has no runtime entry outside the Next.js bundler. vi.mock is
// hoisted above the imports below, so a static import is safe here.
vi.mock("server-only", () => ({}))

const JSON_OPTIONS = { header: 1, raw: true, defval: "" } as const

/** A workbook whose first sheet *declares* `ref` but holds only one cell. */
function workbookDeclaring(ref: string): XLSX.WorkBook {
  const sheet: XLSX.WorkSheet = { A1: { t: "s", v: "only cell" }, "!ref": ref }
  return { SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } }
}

function workbookOfRows(rows: unknown[][]): XLSX.WorkBook {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  return { SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } }
}

describe("readFirstSheetRows", () => {
  it("reads an ordinary sheet unchanged", () => {
    const rows = readFirstSheetRows(
      workbookOfRows([
        ["Item", "Price"],
        ["Flour", 12],
      ]),
      JSON_OPTIONS
    )

    expect(rows).toEqual([
      ["Item", "Price"],
      ["Flour", 12],
    ])
  })

  it("returns null when the workbook has no sheets", () => {
    expect(
      readFirstSheetRows({ SheetNames: [], Sheets: {} }, JSON_OPTIONS)
    ).toBeNull()
  })

  it("refuses too many sheets", () => {
    const names = Array.from(
      { length: SHEET_LIMITS.sheets + 1 },
      (_, index) => `Sheet${index}`
    )
    const workbook: XLSX.WorkBook = {
      SheetNames: names,
      Sheets: Object.fromEntries(
        names.map((name) => [name, XLSX.utils.aoa_to_sheet([["x"]])])
      ),
    }

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).toThrow(
      ImportTooComplexError
    )
  })

  it("refuses a sheet declaring too many rows, without expanding it", () => {
    // The sheet holds one real cell; only the declared range is oversized.
    // A limit applied after sheet_to_json would never see this.
    const workbook = workbookDeclaring(`A1:B${SHEET_LIMITS.rows + 1}`)

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).toThrow(
      /rows; the limit is/
    )
  })

  it("refuses a sheet declaring too many columns", () => {
    const lastColumn = XLSX.utils.encode_col(SHEET_LIMITS.columns)
    const workbook = workbookDeclaring(`A1:${lastColumn}2`)

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).toThrow(
      /columns; the limit is/
    )
  })

  it("refuses a sheet whose row and column counts are each legal but multiply out", () => {
    // 90,000 rows and 100 columns are both under their own ceilings, but the
    // product is 9,000,000 cells — the case a per-dimension limit misses.
    const rows = 90_000
    const columns = 100
    expect(rows).toBeLessThanOrEqual(SHEET_LIMITS.rows)
    expect(columns).toBeLessThanOrEqual(SHEET_LIMITS.columns)
    expect(rows * columns).toBeGreaterThan(SHEET_LIMITS.cells)

    const workbook = workbookDeclaring(
      `A1:${XLSX.utils.encode_col(columns - 1)}${rows}`
    )

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).toThrow(
      /too many cells/
    )
  })

  it("accepts a sheet exactly at the limits", () => {
    const workbook = workbookDeclaring(
      `A1:${XLSX.utils.encode_col(SHEET_LIMITS.columns - 1)}2`
    )

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).not.toThrow()
  })

  it("reads a sheet with no declared range", () => {
    // `!ref` is optional; its absence must not be treated as oversized.
    const workbook: XLSX.WorkBook = {
      SheetNames: ["Sheet1"],
      Sheets: { Sheet1: { A1: { t: "s", v: "value" } } },
    }

    expect(() => readFirstSheetRows(workbook, JSON_OPTIONS)).not.toThrow()
  })
})

describe("complexityMessage", () => {
  it("surfaces the ceiling message so a caller can show it", () => {
    expect(complexityMessage(new ImportTooComplexError("too big"))).toBe(
      "too big"
    )
  })

  it("stays silent for unrelated failures, which get the generic message", () => {
    expect(complexityMessage(new Error("corrupt zip"))).toBeNull()
    expect(complexityMessage("not an error")).toBeNull()
  })
})

/**
 * These build genuine compressed archives rather than pre-parsed workbooks,
 * because the defect being guarded is one of *ordering*: the ceiling has to
 * bite before SheetJS inflates anything.
 */
describe("assertArchiveWithinBudget", () => {
  /** A minimal zip central directory declaring one entry's sizes. */
  function archive(compressed: number, uncompressed: number, entries = 1) {
    const name = Buffer.from("xl/worksheets/sheet1.xml")
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(compressed, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    name.copy(central, 46)

    const directory = Buffer.concat(
      Array.from({ length: entries }, () => central)
    )
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(entries, 10)
    eocd.writeUInt32LE(0, 16)
    return Buffer.concat([directory, eocd]).subarray(0)
  }

  it("accepts an ordinary spreadsheet", () => {
    expect(() =>
      assertArchiveWithinBudget(archive(20_000, 200_000))
    ).not.toThrow()
  })

  it("refuses an archive that declares more inflated bytes than the budget", () => {
    expect(() =>
      assertArchiveWithinBudget(
        archive(50_000, ARCHIVE_LIMITS.uncompressedBytes + 1)
      )
    ).toThrow(ImportTooComplexError)
  })

  it("refuses a bomb by its inflate ratio", () => {
    // 4KB claiming to become 400MB is the classic shape.
    expect(() =>
      assertArchiveWithinBudget(archive(4_096, 400 * 1024 * 1024))
    ).toThrow(ImportTooComplexError)
  })

  it("refuses a ZIP64 archive rather than mis-reading its sizes", () => {
    expect(() =>
      assertArchiveWithinBudget(archive(0xffffffff, 0xffffffff))
    ).toThrow(ImportTooComplexError)
  })

  it("refuses an archive with too many entries", () => {
    expect(() =>
      assertArchiveWithinBudget(archive(10, 100, ARCHIVE_LIMITS.entries + 1))
    ).toThrow(ImportTooComplexError)
  })

  it("passes through something that is not a zip at all", () => {
    // Not this function's job to reject; SheetJS reports malformed input.
    expect(() =>
      assertArchiveWithinBudget(Buffer.from("not a zip"))
    ).not.toThrow()
  })

  it("does not refuse a small well-compressed sheet on ratio alone", () => {
    expect(() =>
      assertArchiveWithinBudget(archive(500, 1_000_000))
    ).not.toThrow()
  })

  it("accepts a real workbook written by the library", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["name", "price"],
      ["carrots", 12],
    ])
    const book: XLSX.WorkBook = {
      SheetNames: ["Sheet1"],
      Sheets: { Sheet1: sheet },
    }
    const bytes = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer

    expect(() => assertArchiveWithinBudget(bytes)).not.toThrow()
  })
})
