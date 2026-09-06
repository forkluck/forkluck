import "server-only"

import * as XLSX from "xlsx"

/**
 * Complexity ceilings for uploaded documents.
 *
 * The encoded payload was already capped at 8M base64 characters, but that
 * bounds the *compressed* size only. XLSX is a zip: a small upload can declare
 * a worksheet with millions of cells, and `sheet_to_json` materializes the
 * whole thing into JavaScript objects before anything gets a chance to reject
 * it. A PDF is the same shape of problem — page count and text-item count are
 * unbounded by file size.
 *
 * So the limits here are on what the document expands into, and they are
 * checked *before* the expansion happens: a worksheet is measured from the
 * `!ref` range it declares, and a PDF is measured page by page as it is read.
 *
 * The numbers are far above any real supplier report — the largest purchase
 * exports seen are a few thousand rows — and far below what would exhaust a
 * request's memory.
 */

export const SHEET_LIMITS = {
  sheets: 20,
  rows: 100_000,
  columns: 512,
  cells: 2_000_000,
} as const

/**
 * Raw bytes of an uploaded photo. The owner's receipt photos are 3.5–5.5 MB;
 * `prepareImage` shrinks whatever arrives to roughly 1 MB before the model
 * sees it, so this bounds the request, not the extraction.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 8_000_000

export const PDF_LIMITS = {
  pages: 200,
  itemsPerPage: 20_000,
  totalCharacters: 5_000_000,
} as const

/**
 * What an XLSX archive may declare before we agree to decompress it.
 *
 * `SHEET_LIMITS` is measured from the parsed workbook, which is already too
 * late: `XLSX.read` inflates every entry first. These bound the archive from
 * its own central directory, which stores each entry's uncompressed size
 * without decompressing anything.
 */
export const ARCHIVE_LIMITS = {
  /** Total inflated bytes across all entries. */
  uncompressedBytes: 256 * 1024 * 1024,
  /** Inflated-to-stored ratio. Ordinary spreadsheets sit far below this. */
  ratio: 200,
  entries: 512,
} as const

/** Thrown when a document is structurally too large to process. */
export class ImportTooComplexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImportTooComplexError"
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const ZIP64_SENTINEL = 0xffffffff

/**
 * Refuse an XLSX whose own directory says it inflates past
 * {@link ARCHIVE_LIMITS} — before SheetJS decompresses it.
 *
 * An XLSX is a zip, and a zip's central directory records every entry's
 * uncompressed size in plain bytes at the end of the file. Reading it costs
 * nothing and needs no inflation, so a bomb is refused while it is still a
 * few kilobytes of upload rather than after it has become gigabytes of
 * worksheet XML.
 *
 * A file this cannot parse is passed through untouched: this is a ceiling on
 * the obviously hostile, not a validity check. SheetJS still reports a
 * malformed archive in its own words.
 */
export function assertArchiveWithinBudget(buffer: Buffer): void {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === null) return

  const entries = buffer.readUInt16LE(eocd + 10)
  if (entries > ARCHIVE_LIMITS.entries) {
    throw new ImportTooComplexError(
      `That file contains ${entries.toLocaleString()} parts; the limit is ${ARCHIVE_LIMITS.entries.toLocaleString()}.`
    )
  }

  let offset = buffer.readUInt32LE(eocd + 16)
  let compressed = 0
  let uncompressed = 0
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length) return
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) return

    const entryCompressed = buffer.readUInt32LE(offset + 20)
    const entryUncompressed = buffer.readUInt32LE(offset + 24)
    // ZIP64 stores the real sizes in an extra field. Rather than parse it,
    // refuse: nothing a kitchen exports is a 4GB spreadsheet.
    if (
      entryCompressed === ZIP64_SENTINEL ||
      entryUncompressed === ZIP64_SENTINEL
    ) {
      throw new ImportTooComplexError(
        "That file is too large to process. Export a smaller range and try again."
      )
    }
    compressed += entryCompressed
    uncompressed += entryUncompressed

    if (uncompressed > ARCHIVE_LIMITS.uncompressedBytes) {
      throw new ImportTooComplexError(
        "That file expands to too much data to process. Export a smaller range and try again."
      )
    }

    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32)
  }

  // Ratio is the zip-bomb signature: a few KB claiming to inflate to GBs.
  // Checked only once the archive is big enough for the ratio to mean
  // something, so a tiny well-compressed sheet is not caught by it.
  if (
    compressed > 0 &&
    uncompressed > 16 * 1024 * 1024 &&
    uncompressed / compressed > ARCHIVE_LIMITS.ratio
  ) {
    throw new ImportTooComplexError(
      "That file expands to too much data to process. Export a smaller range and try again."
    )
  }
}

/** Locate the end-of-central-directory record, scanning back over its
 * variable-length comment. Returns null when this is not a zip at all. */
function findEndOfCentralDirectory(buffer: Buffer): number | null {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return null
}

/**
 * Read the first worksheet as rows, refusing anything past {@link SHEET_LIMITS}.
 *
 * Returns null when the workbook has no sheets, which callers report as their
 * own message.
 */
export function readFirstSheetRows(
  workbook: XLSX.WorkBook,
  options: XLSX.Sheet2JSONOpts
): unknown[][] | null {
  if (workbook.SheetNames.length > SHEET_LIMITS.sheets) {
    throw new ImportTooComplexError(
      `That file has ${workbook.SheetNames.length} sheets; the limit is ${SHEET_LIMITS.sheets}.`
    )
  }

  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return null
  const sheet = workbook.Sheets[sheetName]

  // `!ref` is the range the sheet declares. Measuring it first means an
  // oversized sheet is refused without ever being expanded into objects.
  const ref = sheet["!ref"]
  if (ref) {
    const range = XLSX.utils.decode_range(ref)
    const rows = range.e.r - range.s.r + 1
    const columns = range.e.c - range.s.c + 1
    if (rows > SHEET_LIMITS.rows) {
      throw new ImportTooComplexError(
        `That sheet has ${rows.toLocaleString()} rows; the limit is ${SHEET_LIMITS.rows.toLocaleString()}.`
      )
    }
    if (columns > SHEET_LIMITS.columns) {
      throw new ImportTooComplexError(
        `That sheet has ${columns.toLocaleString()} columns; the limit is ${SHEET_LIMITS.columns.toLocaleString()}.`
      )
    }
    if (rows * columns > SHEET_LIMITS.cells) {
      throw new ImportTooComplexError(
        `That sheet has too many cells to process; the limit is ${SHEET_LIMITS.cells.toLocaleString()}.`
      )
    }
  }

  return XLSX.utils.sheet_to_json<unknown[]>(sheet, options)
}

/** Message for a caller that returns `{ error }` rather than throwing. */
export function complexityMessage(error: unknown): string | null {
  return error instanceof ImportTooComplexError ? error.message : null
}
