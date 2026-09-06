import type { CurrencyCode } from "@/lib/business-settings"
import type { InvoiceRow } from "@/lib/backend/types"
import { formatCents } from "@/lib/money"

/**
 * What the Issue column says about a row, or null when nothing is wrong with
 * it. Django decides *which* issue a row has — `issueKind` is already the
 * worst one, in its own precedence — so this only puts that decision into
 * words.
 */
export function issueText(
  row: InvoiceRow,
  currencyCode: CurrencyCode
): string | null {
  switch (row.issueKind) {
    case "no-lines":
      return "No lines read"
    case "unmatched-lines": {
      const count = row.unresolvedLineCount
      return `${count} unmatched line${count === 1 ? "" : "s"}`
    }
    case "total-mismatch": {
      const delta = row.totalDeltaCents
      // An unannotated read knows the totals disagree without knowing by how
      // much, so the amount is dropped rather than guessed at.
      if (delta === null) return "Total doesn't match lines"
      const amount = formatCents(delta, currencyCode)
      // formatCents already carries the minus sign; only a surplus needs one.
      return `Total doesn't match lines (${delta > 0 ? `+${amount}` : amount})`
    }
    case "unknown-supplier":
      return "Unknown supplier"
    default:
      return null
  }
}
