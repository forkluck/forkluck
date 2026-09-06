import { cache } from "react"
import { redirect } from "next/navigation"

import { getSessionPayload } from "@/lib/backend/queries"
import type { SessionPayload } from "@/lib/backend/schemas"

/** One session read per request, however many callers ask for it. */
export const getSession = cache(async () => getSessionPayload())

export type SessionUser = SessionPayload["user"]

/**
 * Sends a signed-out user to /login. Not the security check: http/auth.py
 * answers 401 either way. Actions that throw need this. Actions that return
 * an error object get the redirect from actionErrorMessage instead.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) redirect("/login")
  return session.user
}
