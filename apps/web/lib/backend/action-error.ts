import "server-only"

import { redirect } from "next/navigation"

import { BackendUnauthorizedError } from "@/lib/backend/client"

/**
 * The message a Server Action hands back in its `{ error }` union. An expired
 * session is not something the page can render — the data behind it is gone —
 * so this redirects instead of returning; `redirect()` throws, which is what
 * lets it escape the caller's catch block. A refused write on a read-only
 * account is an ordinary error: the backend's own sentence says to subscribe,
 * and the screen shows it where it shows every other refusal, without
 * discarding what the user was in the middle of.
 */
export function actionErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof BackendUnauthorizedError) redirect("/login")
  return cause instanceof Error && cause.message ? cause.message : fallback
}
