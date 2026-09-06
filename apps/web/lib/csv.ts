const FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/

/** Encode one CSV cell and keep spreadsheet programs from evaluating text. */
export function csvCell(
  value: string | number,
  { alwaysQuote = false }: { alwaysQuote?: boolean } = {}
) {
  const text = String(value)
  const safe =
    typeof value === "string" && FORMULA_PREFIX.test(text) ? `'${text}` : text
  if (!alwaysQuote && !/[",\n\r]/.test(safe)) return safe
  return `"${safe.replaceAll('"', '""')}"`
}
