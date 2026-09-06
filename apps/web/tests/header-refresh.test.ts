import { describe, expect, it, vi } from "vitest"

import type { PosConnectionRow } from "../lib/backend/types"
import { queueHeaderConnections } from "../lib/header-refresh"

function connection(
  provider: "square" | "shopify",
  status: PosConnectionRow["status"] = "active"
): PosConnectionRow {
  return {
    provider,
    providerAccountId: "merchant",
    generation: 1,
    status,
    merchantId: "merchant",
    shopDomain: "",
    scopes: "",
    providerTimezone: "UTC",
    currencyCode: "USD",
    lastSyncedAt: "2026-08-11T14:10:00Z",
    backfilledAt: null,
    lastError: "",
    connectedAt: "2026-08-01T00:00:00Z",
  }
}

describe("header refresh", () => {
  it("queues every active channel and reports provider failures", async () => {
    const sync = vi.fn(async (provider: "square" | "shopify") =>
      provider === "shopify"
        ? { error: "Shopify is unavailable" }
        : {
            syncRun: {
              id: "run-1",
              provider,
              providerAccountId: "merchant",
              connectionGeneration: 1,
              status: "queued" as const,
              progress: {},
              cursor: { watermark: null, continuationPasses: 0 },
              result: {},
              error: "",
              attempts: 0,
              maxAttempts: 3,
              queuedAt: "2026-08-12T00:00:00Z",
              availableAt: "2026-08-12T00:00:00Z",
              startedAt: null,
              heartbeatAt: null,
              finishedAt: null,
            },
          }
    )

    const result = await queueHeaderConnections(
      [
        connection("square"),
        connection("shopify"),
        connection("square", "needs_reconnect"),
      ],
      sync
    )

    expect(sync.mock.calls).toEqual([["square"], ["shopify"]])
    expect(result.runs.map((run) => run.id)).toEqual(["run-1"])
    expect(result.failures).toEqual([
      { provider: "shopify", error: "Shopify is unavailable" },
    ])
  })

  it("does not start a sync when no active channel is connected", async () => {
    const sync = vi.fn()

    await expect(queueHeaderConnections([], sync)).resolves.toEqual({
      runs: [],
      failures: [],
    })
    expect(sync).not.toHaveBeenCalled()
  })
})
