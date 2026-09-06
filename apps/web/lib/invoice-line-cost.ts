import { packGramsFor, parseSize } from "@/lib/purchase-import"
import { normalizePackUnit, type PackUnitSlug } from "@/lib/unit-registry"

type InvoiceLineCostSource = {
  unit: string
  packSize: string
  quantity: number | null
  unitPriceCents: number | null
  lineAmountCents: number | null
}

export type InvoiceLinePack = {
  amount: number
  unit: PackUnitSlug
  /** Grams in the pack, null when its unit carries no weight of its own. */
  grams: number | null
  catchWeight: boolean
}

/**
 * The unit a printed U/M column prices by. A container such as CS does not
 * describe its contents, so its pack-size text remains authoritative.
 */
export function packUnitFromLabel(label: string): PackUnitSlug | null {
  const match = normalizePackUnit(label)
  return match && !match.container ? match.slug : null
}

/** A real weight is kept at least 1g; volume and count packs have no weight. */
function packGrams(amount: number, unit: string): number | null {
  const grams = packGramsFor(amount, unit)
  return grams === null ? null : Math.max(1, grams)
}

/** Catch-weight lines cost one printed unit; containers need a readable size. */
export function resolveInvoiceLinePack(
  line: Pick<InvoiceLineCostSource, "unit" | "packSize">
): InvoiceLinePack | null {
  const pricedBy = packUnitFromLabel(line.unit)
  if (pricedBy) {
    return {
      amount: 1,
      unit: pricedBy,
      grams: packGrams(1, pricedBy),
      catchWeight: true,
    }
  }
  if (!line.packSize) return null
  const size = parseSize(line.packSize)
  if ("error" in size) return null
  return {
    amount: size.amount,
    unit: size.unit,
    grams: packGrams(size.amount, size.unit),
    catchWeight: false,
  }
}

/** Printed unit price wins; otherwise divide the extended amount by quantity. */
export function invoiceLinePackPriceCents(
  line: Pick<
    InvoiceLineCostSource,
    "quantity" | "unitPriceCents" | "lineAmountCents"
  >
): number | null {
  if (line.unitPriceCents !== null) return line.unitPriceCents
  if (line.lineAmountCents === null) return null
  const quantity = line.quantity ?? 1
  if (quantity <= 0) return null
  return Math.round(line.lineAmountCents / quantity)
}
