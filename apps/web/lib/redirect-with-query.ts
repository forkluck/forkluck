import { redirect } from "next/navigation"

/**
 * Redirect to a route that moved, keeping the query string. Old links and the
 * OAuth returns still pointing at the old path carry their whole payload in
 * that query, so dropping it would break the return rather than relocate it.
 */
export function redirectWithQuery(
  path: string,
  searchParams: Record<string, string | string[] | undefined>
): never {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.set(key, value)
    else if (Array.isArray(value))
      for (const one of value) params.append(key, one)
  }
  const query = params.toString()
  redirect(query ? `${path}?${query}` : path)
}
