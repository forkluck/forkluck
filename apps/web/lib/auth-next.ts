/** Auth may continue to a page or our OAuth endpoint, always on this origin. */
export function safeAuthNext(next: string | string[] | undefined): string {
  if (typeof next !== "string" || next.length > 8192) return "/"
  if (!next.startsWith("/") || next.startsWith("//")) return "/"
  return /[\\\x00-\x20\x7f]/.test(next) ? "/" : next
}
