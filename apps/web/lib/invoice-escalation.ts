import type { NormalizedInvoice } from "@/lib/invoice-import"

/**
 * Validator-gated escalation: the deterministic checks in
 * normalizeInvoiceExtraction (arithmetic, header fields, per-line
 * uncertainty) decide whether a document earns a second, more expensive
 * read. Pure so the eval script and the parse pipeline share one rule.
 */

/** Every reason the normalized result is not yet trustworthy, in reading
 * order. Empty means the document reconciles and nothing was uncertain. */
export function extractionFindings(invoice: NormalizedInvoice): string[] {
  const findings: string[] = []
  if (invoice.totalCents === null) {
    findings.push("The invoice total could not be read.")
  }
  if (invoice.invoiceDate === null) {
    findings.push("The invoice date could not be read.")
  }
  if (invoice.totalsMismatch) findings.push(invoice.totalsMismatch)
  for (const line of invoice.lines) {
    if (!line.uncertain) continue
    findings.push(
      `Line ${line.position + 1} "${line.description}": ${line.reason ?? "not read confidently"}`
    )
  }
  return findings
}

export function needsEscalation(invoice: NormalizedInvoice): boolean {
  return extractionFindings(invoice).length > 0
}

/** Framing for the second pass: the model sees what the validator caught. */
export function escalationHint(findings: string[]): string {
  return [
    "A first read of this document did not reconcile. Re-read the item table, the totals block and the header carefully; the checks that failed were:",
    ...findings.map((finding) => `- ${finding}`),
    "Transcribe exactly what is printed. Leave a value null rather than guessing.",
  ].join("\n")
}

/** Between two reads of the same document, keep the one with fewer findings;
 * on a tie the escalation pass wins because it was the stronger read. */
export function chooseExtraction<T extends NormalizedInvoice>(
  first: T,
  escalation: T
): { chosen: T; pick: "first" | "escalation" } {
  const firstFindings = extractionFindings(first).length
  const escalationFindings = extractionFindings(escalation).length
  return escalationFindings <= firstFindings
    ? { chosen: escalation, pick: "escalation" }
    : { chosen: first, pick: "first" }
}
