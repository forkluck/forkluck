import type { PosConnectionRow, PosSyncRun } from "./backend/types"

/** A provider name is not an account identity: reconnecting can replace it. */
export function syncRunForConnection(
  runs: readonly PosSyncRun[],
  connection: PosConnectionRow | undefined
): PosSyncRun | undefined {
  if (!connection) return undefined
  return runs.find(
    (run) =>
      run.provider === connection.provider &&
      run.providerAccountId === connection.providerAccountId &&
      run.connectionGeneration === connection.generation
  )
}

/** The run the settings page has to keep watching, if any channel has one. */
export function activeSyncRun(
  runs: readonly PosSyncRun[],
  connections: readonly PosConnectionRow[]
): PosSyncRun | undefined {
  for (const connection of connections) {
    const run = syncRunForConnection(runs, connection)
    if (run?.status === "queued" || run?.status === "running") return run
  }
  return undefined
}
