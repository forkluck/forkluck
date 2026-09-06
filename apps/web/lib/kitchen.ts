import type { SessionPayload } from "@/lib/backend/schemas"

/**
 * A kitchen the account is a member of. The account's own kitchen is the
 * absence of one, so `null` — not an entry — is "My kitchen".
 */
export type ActiveKitchen = SessionPayload["kitchens"][number]

/** Which kitchen the last visit was looking at, by owner id. */
export const KITCHEN_COOKIE = "forkluck_kitchen"

const COOKIE_MAX_AGE_DAYS = 180

/**
 * The kitchen this request is in. The cookie is untrusted — a membership that
 * was revoked, or an id from another account entirely, resolves to the user's
 * own kitchen rather than to nothing.
 */
export function resolveActiveKitchen(
  session: SessionPayload,
  cookieValue: string | undefined
): ActiveKitchen | null {
  if (cookieValue) {
    return (
      session.kitchens.find((kitchen) => kitchen.ownerId === cookieValue) ??
      null
    )
  }
  // Landing rule: staff invited into a kitchen have nothing of their own, so
  // their first visit opens the kitchen that invited them rather than an
  // empty list they never asked for.
  if (session.billing.recipeCount === 0 && session.kitchens.length > 0) {
    return session.kitchens[0]
  }
  return null
}

/** Remembers the pick client-side, the way the reporting period is. */
export function writeKitchenCookie(ownerId: string | null) {
  document.cookie = ownerId
    ? `${KITCHEN_COOKIE}=${encodeURIComponent(ownerId)}; path=/; max-age=${
        COOKIE_MAX_AGE_DAYS * 86_400
      }; samesite=lax`
    : `${KITCHEN_COOKIE}=; path=/; max-age=0; samesite=lax`
}
