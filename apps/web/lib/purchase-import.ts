import { normalizeIngredientName } from "./pricing"
import {
  convertAmount,
  normalizePackUnit,
  type PackUnitSlug,
} from "./unit-registry"

export type PurchaseEntryStatus = "new" | "update"

export type PurchaseEntry = {
  supplier: string | null
  externalId: string | null
  name: string
  rawSize: string
  quantity: number | null
  packAmount: number
  packUnit: PackUnitSlug
  /** Grams in the pack, or null when the unit carries no weight of its own. */
  packGrams: number | null
  packPriceCents: number
  preferred: boolean
  status: PurchaseEntryStatus
  ingredientId: string | null
}

export type SkippedPurchaseRow = {
  supplier: string | null
  externalId: string | null
  name: string
  rawSize: string
  quantity: number | null
  packPriceCents: number | null
  suggestedPackAmount: number | null
  suggestedPackUnit: PackUnitSlug | null
  reason: string
  status: "review" | "ignored"
}

export type PurchaseImportSource = {
  supplier: string
  label: string
  periodStart: string | null
  periodEnd: string | null
}

export type PurchaseImport = {
  source: PurchaseImportSource | null
  totalRows: number
  entries: PurchaseEntry[]
  skipped: SkippedPurchaseRow[]
}

type ParsePurchaseOptions = {
  fileName?: string
}

// "4 LB", "8 X 1 LB", "24 X 150 ML", "4X12 CT", "1 KG". The unit may be two
// words ("FL OZ"), so it runs to the end of the text rather than one token.
const sizePattern =
  /^(\d+(?:[.,]\d+)?)\s*(?:X\s*(\d+(?:[.,]\d+)?)\s*)?([A-Z][A-Z ]*)\.?$/

/**
 * A printed pack size as an amount and a stored slug. "N X M UNIT" multiplies
 * whatever the family — 8 X 1 LB is 8 lb and 24 X 150 ML is 3600 ml — because
 * the case is what the price is for.
 */
export function parseSize(
  raw: string
): { amount: number; unit: PackUnitSlug } | { error: string } {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, " ")
  const match = normalized.match(sizePattern)
  if (!match) return { error: `Couldn't read size "${raw.trim()}"` }
  const first = Number(match[1].replace(",", "."))
  const second = match[2] ? Number(match[2].replace(",", ".")) : null
  const unit = normalizePackUnit(match[3])
  if (!unit) return { error: `Unsupported size unit "${match[3].trim()}"` }
  const amount = second === null ? first : first * second
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: `Couldn't read size "${raw.trim()}"` }
  }
  return { amount, unit: unit.slug }
}

/** Grams in a pack, or null when its unit carries no weight of its own — a
 * volume or a count is priced in what it was bought by, not converted. */
export function packGramsFor(amount: number, unit: string): number | null {
  const grams = convertAmount(amount, unit, "g")
  return grams === null ? null : Math.round(grams)
}

function findColumn(header: string[], patterns: RegExp[]): number {
  return header.findIndex((cell) =>
    patterns.some((pattern) => pattern.test(cell))
  )
}

function numberFromCell(value: string): number {
  return Number(value.replaceAll(",", "").replace(/^\$/, "").trim())
}

function exportPeriod(fileName: string | undefined) {
  const match = fileName?.match(
    /(?:^|_)(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:\.[^.]+)?$/
  )
  return {
    periodStart: match?.[1] ?? null,
    periodEnd: match?.[2] ?? null,
  }
}

function markPreferredSupplierItems(entries: PurchaseEntry[]) {
  const groups = new Map<string, PurchaseEntry[]>()
  for (const entry of entries) {
    if (!entry.supplier) continue
    const key = normalizeIngredientName(entry.name)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const quantityDifference = (right.quantity ?? 0) - (left.quantity ?? 0)
      if (quantityDifference !== 0) return quantityDifference
      return (left.externalId ?? "").localeCompare(right.externalId ?? "")
    })
    if (group[0]) group[0].preferred = true
  }
}

/**
 * Parses purchase-report rows (from an xlsx/csv export) into pantry entries.
 * Supplier portal exports keep every supplier SKU and treat Current Price as
 * a per-pack price. Generic paid-total reports retain the original behavior:
 * the paid total is divided by the quantity purchased. Unsupported or
 * ambiguous packs are surfaced for review instead of guessed.
 */
export function parsePurchaseRows(
  rows: unknown[][],
  options: ParsePurchaseOptions = {}
): PurchaseImport {
  const stringRows = rows.map((row) => row.map((cell) => String(cell ?? "")))

  const headerIndex = stringRows.findIndex((row) => {
    const cells = row.map((cell) => cell.toLowerCase())
    return (
      cells.some((cell) => /name|title|item|product|description/.test(cell)) &&
      cells.some((cell) => /size|pack/.test(cell))
    )
  })
  if (headerIndex === -1) {
    return {
      source: null,
      totalRows: 0,
      entries: [],
      skipped: [
        {
          supplier: null,
          externalId: null,
          name: "—",
          rawSize: "",
          quantity: null,
          packPriceCents: null,
          suggestedPackAmount: null,
          suggestedPackUnit: null,
          reason:
            "No header row found — the file needs columns like Name, Quantity, Size, Paid Total.",
          status: "review",
        },
      ],
    }
  }

  const header = stringRows[headerIndex].map((cell) =>
    cell.toLowerCase().trim()
  )
  const nameIdx = findColumn(header, [
    /^title$/,
    /name|item|product|description/,
  ])
  const idIdx = findColumn(header, [/^id$|sku|item id|product id/])
  const sizeIdx = findColumn(header, [/size|pack/])
  const qtyIdx = findColumn(header, [/^qty|quantity/])
  const priceIdx = findColumn(header, [/paid|total|price|amount|cost/])
  if (priceIdx === -1) {
    return {
      source: null,
      totalRows: 0,
      entries: [],
      skipped: [
        {
          supplier: null,
          externalId: null,
          name: "—",
          rawSize: "",
          quantity: null,
          packPriceCents: null,
          suggestedPackAmount: null,
          suggestedPackUnit: null,
          reason: "No price column found (Current Price, Paid Total…).",
          status: "review",
        },
      ],
    }
  }

  const isBaldor =
    idIdx !== -1 &&
    header[nameIdx] === "title" &&
    header[priceIdx] === "current price"
  const period = exportPeriod(options.fileName)
  const source: PurchaseImportSource | null = isBaldor
    ? {
        supplier: "baldor",
        label: "Baldor",
        ...period,
      }
    : null
  const priceIsPerPack = /current|unit|pack/.test(header[priceIdx])

  const byKey = new Map<string, PurchaseEntry>()
  const skipped: SkippedPurchaseRow[] = []
  let totalRows = 0

  for (const row of stringRows.slice(headerIndex + 1)) {
    const name = (row[nameIdx] ?? "").trim()
    if (!name) continue
    totalRows++

    const externalId = idIdx === -1 ? null : (row[idIdx] ?? "").trim()
    const rawSize = (row[sizeIdx] ?? "").trim()
    const quantityRaw = qtyIdx === -1 ? "1" : (row[qtyIdx] ?? "1")
    const quantityValue = numberFromCell(quantityRaw)
    const quantity = Number.isFinite(quantityValue) ? quantityValue : null
    const size = parseSize(rawSize)
    const priceValue = numberFromCell(row[priceIdx] ?? "")
    const validPrice = Number.isFinite(priceValue) && priceValue > 0
    const validQuantityForPrice =
      priceIsPerPack || (quantity !== null && quantity > 0)
    const packPriceCents =
      validPrice && validQuantityForPrice
        ? Math.round(
            priceIsPerPack ? priceValue * 100 : (priceValue * 100) / quantity!
          )
        : null
    const skippedRow = (reason: string): SkippedPurchaseRow => ({
      supplier: source?.supplier ?? null,
      externalId: externalId || null,
      name,
      rawSize,
      quantity,
      packPriceCents,
      suggestedPackAmount: "error" in size ? null : size.amount,
      suggestedPackUnit: "error" in size ? null : size.unit,
      reason,
      status: "review",
    })

    if (isBaldor && !externalId) {
      skipped.push(skippedRow("Baldor item ID is missing"))
      continue
    }

    const validQuantity =
      quantity !== null && (priceIsPerPack ? quantity >= 0 : quantity > 0)
    if (!validQuantity) {
      skipped.push(skippedRow(`Couldn't read quantity "${quantityRaw}"`))
      continue
    }

    if ("error" in size) {
      skipped.push(skippedRow(size.error))
      continue
    }

    if (!validPrice || packPriceCents === null) {
      skipped.push(skippedRow(`Couldn't read price "${row[priceIdx] ?? ""}"`))
      continue
    }

    const packGrams = packGramsFor(size.amount, size.unit)
    if (packPriceCents < 1 || (packGrams !== null && packGrams < 1)) {
      skipped.push(skippedRow("Price or size rounds to zero"))
      continue
    }

    const key = isBaldor
      ? `${source!.supplier}:${externalId!.toLowerCase()}`
      : normalizeIngredientName(name)
    byKey.set(key, {
      supplier: source?.supplier ?? null,
      externalId: externalId || null,
      name,
      rawSize,
      quantity: qtyIdx === -1 ? null : quantity,
      packAmount: size.amount,
      packUnit: size.unit,
      packGrams,
      packPriceCents,
      preferred: false,
      status: "new",
      ingredientId: null,
    })
  }

  const entries = [...byKey.values()]
  markPreferredSupplierItems(entries)
  return { source, totalRows, entries, skipped }
}
