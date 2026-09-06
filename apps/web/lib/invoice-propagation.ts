/**
 * Tag once per batch: resolving or ignoring one line answers every other line
 * of the same supplier item in the same import, across files. The shapes are
 * structural so the import dialog's state passes straight in.
 */

import { supplierKeyFromName } from "@/lib/invoice-import"
import type { InvoiceReviewMode } from "@/lib/invoice-review"
import { centsToDollarInput } from "@/lib/money"

export type PropagationLine = {
  key: string
  mode: InvoiceReviewMode
  /** Set by this module, so the badge can say the merchant never clicked it. */
  propagated: boolean
  categoryId: string | null
  ingredientId: string
  name: string
  amount: string
  unit: string
  price: string
  /** Whether this line joins the supplier's memory. A merchant who declined
   *  the item on one line declined it on every line of the same item. */
  remember: boolean
  entry: {
    itemKey: string
    /** A proposed new product carries its own pack and price. */
    match: {
      kind: string
      cost?: {
        packAmount: number
        packUnit: string
        packPriceCents: number
      }
    }
  }
}

export type PropagationInvoice = {
  key: string
  supplierName: string
  result: { supplier: string; supplierName: string }
  lines: PropagationLine[]
}

export type PropagationPatch = {
  mode: "resolved" | "ignored"
  propagated: true
  ingredientId?: string
  name?: string
  amount?: string
  unit?: string
  price?: string
  categoryId?: string | null
  remember?: boolean
}

export type PropagationTarget = {
  invoiceKey: string
  lineKey: string
  patch: PropagationPatch
}

/** The key the import files this invoice under — the same rule the dialog's
 * confirm() sends, so a corrected supplier name propagates by its correction. */
function reviewedSupplierKey(invoice: PropagationInvoice): string {
  const name = invoice.supplierName.trim() || invoice.result.supplierName
  return supplierKeyFromName(name) || invoice.result.supplier
}

/**
 * Every line the merchant's decision on `source` also answers. Targets are
 * still open (`review`/`resolving`) or a proposed new product; a line already
 * settled by hand, and an `auto` price update against confirmed memory, are
 * left alone.
 */
export function propagateResolution(
  invoices: PropagationInvoice[],
  source: { invoiceKey: string; lineKey: string }
): PropagationTarget[] {
  const sourceInvoice = invoices.find(
    (invoice) => invoice.key === source.invoiceKey
  )
  const sourceLine = sourceInvoice?.lines.find(
    (line) => line.key === source.lineKey
  )
  if (!sourceInvoice || !sourceLine) return []
  if (sourceLine.mode !== "resolved" && sourceLine.mode !== "ignored") return []
  const itemKey = sourceLine.entry.itemKey
  if (!itemKey) return []
  const supplier = reviewedSupplierKey(sourceInvoice)

  const targets: PropagationTarget[] = []
  for (const invoice of invoices) {
    if (reviewedSupplierKey(invoice) !== supplier) continue
    for (const line of invoice.lines) {
      if (invoice.key === source.invoiceKey && line.key === source.lineKey) {
        continue
      }
      if (line.entry.itemKey !== itemKey) continue
      const open =
        line.mode === "review" ||
        line.mode === "resolving" ||
        (line.mode === "auto" && line.entry.match.kind === "new")
      if (!open) continue
      targets.push({
        invoiceKey: invoice.key,
        lineKey: line.key,
        patch:
          sourceLine.mode === "ignored"
            ? { mode: "ignored", propagated: true }
            : resolvedPatch(sourceLine, line),
      })
    }
  }
  return targets
}

/**
 * The identity comes from the source; the pack and price stay the target's
 * own wherever it has them — what the reviewer typed, else what its own
 * proposed match read off the document — and are borrowed only when it has
 * neither, because pack price is per-invoice money.
 */
function resolvedPatch(
  source: PropagationLine,
  target: PropagationLine
): PropagationPatch {
  const own = target.entry.match.cost
  const patch: PropagationPatch = {
    mode: "resolved",
    propagated: true,
    ingredientId: source.ingredientId,
    name: source.name,
    remember: source.remember,
  }
  if (!target.amount.trim()) {
    patch.amount = own ? String(own.packAmount) : source.amount
    patch.unit = own ? own.packUnit : source.unit
  }
  if (!target.price.trim()) {
    patch.price = own ? centsToDollarInput(own.packPriceCents) : source.price
  }
  if (target.categoryId === null) patch.categoryId = source.categoryId
  return patch
}

/**
 * One line edit, plus the propagation it triggers, in a single state update:
 * the targets are read from the post-patch batch, and a propagated patch
 * never propagates further.
 */
export function applyLineChange<
  Line extends PropagationLine,
  Invoice extends PropagationInvoice & { lines: Line[] },
>(
  invoices: Invoice[],
  invoiceKey: string,
  lineKey: string,
  patch: Partial<Line>
): Invoice[] {
  const patched = invoices.map((invoice) =>
    invoice.key === invoiceKey
      ? {
          ...invoice,
          lines: invoice.lines.map((line) =>
            line.key === lineKey ? { ...line, ...patch } : line
          ),
        }
      : invoice
  )
  if (patch.mode !== "resolved" && patch.mode !== "ignored") return patched
  const targets = propagateResolution(patched, { invoiceKey, lineKey })
  if (targets.length === 0) return patched
  return patched.map((invoice) => {
    const forInvoice = targets.filter(
      (target) => target.invoiceKey === invoice.key
    )
    if (forInvoice.length === 0) return invoice
    return {
      ...invoice,
      lines: invoice.lines.map((line) => {
        const target = forInvoice.find((row) => row.lineKey === line.key)
        return target ? { ...line, ...target.patch } : line
      }),
    }
  })
}
