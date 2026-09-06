import "server-only"

import { redirect } from "next/navigation"

import {
  BackendRequestError,
  BackendUnauthorizedError,
} from "@/lib/backend/client"

/**
 * The message a Server Action hands back in its `{ error }` union. An expired
 * session is not something the page can render — the data behind it is gone —
 * so this redirects instead of returning; `redirect()` throws, which is what
 * lets it escape the caller's catch block. A lapsed subscription redirects the
 * same way.
 */
export function actionErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof BackendUnauthorizedError) redirect("/login")
  if (
    cause instanceof BackendRequestError &&
    cause.code === "subscription_required"
  ) {
    redirect("/subscribe")
  }
  return cause instanceof Error && cause.message ? cause.message : fallback
}
