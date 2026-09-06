/**
 * Whether Square's modifier lists are behind the sales they belong to.
 *
 * A sync imports the catalog after the orders, so on a healthy run the catalog
 * timestamp is the later of the two. When a catalog refresh is rate-limited or
 * skipped (a partial backfill pass), the sales sync still advances and the
 * catalog timestamp stays put — that ordering is the signal, and it clears
 * itself on the next sync that manages to reach the catalog.
 */
export function isModifierCatalogStale({
  squareConnected,
  squareSyncedAt,
  squareSalesSyncedAt,
}: {
  squareConnected: boolean
  squareSyncedAt: string | null
  squareSalesSyncedAt: string | null
}) {
  if (!squareConnected) return false
  // Nothing has synced yet: the empty state already explains the wait.
  if (!squareSalesSyncedAt) return false
  // Sales arrived but the catalog never did, so its step never succeeded.
  if (!squareSyncedAt) return true
  return new Date(squareSyncedAt) < new Date(squareSalesSyncedAt)
}
