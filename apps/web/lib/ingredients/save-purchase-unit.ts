import {
  disconnectInvoiceItem,
  linkInvoiceItem,
  saveIngredient,
  applyInvoicePrice,
} from "@/app/(app)/ingredients/actions"
import type { PurchaseUnit } from "@/components/ingredients/purchase-unit-fields"
import { dollarsToCents } from "@/lib/money"

/** What the actions want: the typed fields turned into numbers. */
export type PurchasePrice = {
  purchaseCostCents: number
  purchaseSize: number
  purchaseUnit: string
  yieldPercent: number
}

/** Null when the fields cannot price anything yet, so no request is sent. */
export function parsePurchaseUnit(unit: PurchaseUnit): PurchasePrice | null {
  const purchaseCostCents = dollarsToCents(unit.cost)
  if (!unit.unit || purchaseCostCents === null) return null
  // The Size field shows "1" when it is left blank, and the price is read as
  // "per one of the unit": a blank size is one pack, never none.
  const size = Number.parseFloat(unit.size)
  // A blank Yield field is a full yield, the same way a blank Size is one
  // pack. Anything else typed travels as typed, so a 0 or a 120 is refused
  // rather than quietly saved as 100.
  const yieldPercent = Number.parseFloat(unit.yieldPercent)
  return {
    purchaseCostCents,
    purchaseSize: Number.isFinite(size) && size > 0 ? size : 1,
    purchaseUnit: unit.unit,
    yieldPercent: Number.isFinite(yieldPercent) ? yieldPercent : 100,
  }
}

export const MISSING_PURCHASE_PRICE = "Add a cost and a unit first."

/**
 * Writes what an ingredient is bought as, from wherever the fields were shown.
 *
 * Active costing, adding/removing an invoice reference, and explicitly using
 * one of those references are separate single actions in the same save domain.
 */
export async function savePurchaseUnit({
  id,
  unit,
}: {
  id: string
  unit: PurchaseUnit
}): Promise<{ ok: true; editVersion: number } | { error: string }> {
  if (unit.disconnectInvoicePriceId) {
    const dropped = await disconnectInvoiceItem(
      id,
      unit.disconnectInvoicePriceId
    )
    return "error" in dropped
      ? dropped
      : { ok: true, editVersion: dropped.editVersion }
  }

  if (unit.useInvoicePriceId) {
    const used = await applyInvoicePrice(id, unit.useInvoicePriceId)
    return "error" in used ? used : { ok: true, editVersion: used.editVersion }
  }

  if (unit.invoiceLineId) {
    const size = Number.parseFloat(unit.invoicePurchaseSize ?? "")
    const purchaseUnit = unit.invoicePurchaseUnit?.trim() ?? ""
    if (!Number.isFinite(size) || size <= 0 || !purchaseUnit) {
      return { error: "Add the invoice pack size and unit first." }
    }
    const linked = await linkInvoiceItem(id, unit.invoiceLineId, {
      purchaseSize: size,
      purchaseUnit,
    })
    return "error" in linked
      ? linked
      : { ok: true, editVersion: linked.editVersion }
  }
  const purchase = parsePurchaseUnit(unit)
  if (!purchase) return { error: MISSING_PURCHASE_PRICE }
  const result = await saveIngredient({ id, ...purchase })
  if ("error" in result) return { error: result.error }
  // The write bumped the ingredient; whoever shows the pack saves against this.
  return { ok: true, editVersion: result.editVersion }
}
