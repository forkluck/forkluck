export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (!origin || !host) return false
  try {
    // Next builds request.url with its internal listening hostname. Nginx
    // preserves the public Host and supplies the protocol used by Next.
    const { protocol } = new URL(request.url)
    return new URL(origin).origin === new URL(`${protocol}//${host}`).origin
  } catch {
    return false
  }
}
