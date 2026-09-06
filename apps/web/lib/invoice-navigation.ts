const INVOICES_HREF = "/invoices"
const LOCAL_ORIGIN = "https://forkluck.local"

/** Keep an invoice's way back inside the invoices list. */
export function invoiceListHref(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return INVOICES_HREF
  }

  try {
    const url = new URL(value, LOCAL_ORIGIN)
    if (url.origin !== LOCAL_ORIGIN || url.pathname !== INVOICES_HREF) {
      return INVOICES_HREF
    }
    return `${INVOICES_HREF}${url.search}`
  } catch {
    return INVOICES_HREF
  }
}

/** Open a receipt with the exact invoices view it came from. */
export function invoiceDetailHref(publicId: string, returnTo: string): string {
  const detailHref = `/invoices/${encodeURIComponent(publicId)}`
  const listHref = invoiceListHref(returnTo)
  return listHref === INVOICES_HREF
    ? detailHref
    : `${detailHref}?returnTo=${encodeURIComponent(listHref)}`
}
