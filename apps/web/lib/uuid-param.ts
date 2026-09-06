/**
 * Identifier parameters, filtered down to what the Django URL table can match.
 *
 * Several internal reads sit behind `<uuid:…>` path converters. A malformed id
 * never reaches the view: the URL resolver answers 404, which
 * `lib/backend/client.ts` raises as a `BackendRequestError`. Callers of those
 * reads treat a missing row as `null` — a well-formed but unknown id already
 * renders "not found" — so the malformed id has to be rejected here, before a
 * request is made, rather than escaping as an unhandled exception.
 *
 * Rejecting it here also leaves a 404 from the internal-secret guard meaning
 * what `ARCHITECTURE.md` says it means, instead of being swallowed as an empty
 * result.
 */

/**
 * Django's `UUIDConverter.regex`, anchored. Lowercase on purpose: the converter
 * is lowercase-only, so an upper-case id is one the URL table cannot match
 * either, and accepting it here would only move the 404 later.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Return the value only when Django's `uuid` path converter would match it. */
export function uuidParam(value: string | string[] | undefined) {
  return typeof value === "string" && UUID.test(value) ? value : undefined
}
