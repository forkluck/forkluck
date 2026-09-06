import type { PosConnectionRow, PosSyncRun } from "./backend/types"

type Provider = PosConnectionRow["provider"]
type QueueResult = { syncRun: PosSyncRun } | { error: string }
type QueueProvider = (provider: Provider) => Promise<QueueResult>

export type HeaderSyncFailure = {
  provider: Provider
  error: string
}

/** Queue one durable run for every active connection. Duplicate requests are
 * idempotent at the backend and return the already-active run. */
export async function queueHeaderConnections(
  connections: PosConnectionRow[] | null,
  queueProvider: QueueProvider
): Promise<{ runs: PosSyncRun[]; failures: HeaderSyncFailure[] }> {
  const providers = [
    ...new Set(
      (connections ?? [])
        .filter((connection) => connection.status === "active")
        .map((connection) => connection.provider)
    ),
  ]
  const results = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      result: await queueProvider(provider),
    }))
  )
  return {
    runs: results.flatMap(({ result }) =>
      "error" in result ? [] : [result.syncRun]
    ),
    failures: results.flatMap(({ provider, result }) =>
      "error" in result ? [{ provider, error: result.error }] : []
    ),
  }
}
