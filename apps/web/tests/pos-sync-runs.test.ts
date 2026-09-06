import { describe, expect, it } from "vitest"

import type { PosConnectionRow, PosSyncRun } from "../lib/backend/types"
import { activeSyncRun, syncRunForConnection } from "../lib/pos-sync-runs"

function connection(account: string, generation = 1): PosConnectionRow {
  return {
    provider: "shopify",
    providerAccountId: account,
    generation,
    status: "active",
    merchantId: "",
    shopDomain: `${account}.myshopify.com`,
    scopes: "read_orders",
    providerTimezone: "UTC",
    currencyCode: "USD",
    lastSyncedAt: null,
    backfilledAt: null,
    lastError: "",
    connectedAt: "2026-08-13T00:00:00Z",
  }
}

function run(
  account: string,
  status: PosSyncRun["status"],
  connectionGeneration = 1
): PosSyncRun {
  return {
    id: `${account}-${status}`,
    provider: "shopify",
    providerAccountId: account,
    connectionGeneration,
    status,
    progress: {},
    cursor: { watermark: null, continuationPasses: 0 },
    result: {},
    error: status === "failed" ? "Synthetic failure" : "",
    attempts: 1,
    maxAttempts: 3,
    queuedAt: "2026-08-13T00:00:00Z",
    availableAt: "2026-08-13T00:00:00Z",
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
  }
}

describe("POS sync run identity", () => {
  it("ignores a failed run from the provider account that was replaced", () => {
    const current = connection("new-shop")
    const runs = [run("old-shop", "failed"), run("new-shop", "queued")]

    expect(syncRunForConnection(runs, current)?.providerAccountId).toBe(
      "new-shop"
    )
    expect(activeSyncRun(runs, [current])?.providerAccountId).toBe("new-shop")
  })

  it("does not poll for an orphaned active run", () => {
    expect(activeSyncRun([run("old-shop", "running")], [])).toBeUndefined()
  })

  it("ignores a run created before a reconnect to the same account", () => {
    const reconnected = connection("same-shop", 2)

    expect(
      syncRunForConnection([run("same-shop", "failed")], reconnected)
    ).toBeUndefined()
  })
})
