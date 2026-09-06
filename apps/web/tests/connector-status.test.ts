import { describe, expect, it } from "vitest"

import { connectorRow } from "@/lib/connector-status"
import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorSyncRun,
} from "@/lib/backend/types"

const provider: ConnectorProvider = {
  key: "acme",
  displayName: "Acme Produce",
  description: "Invoices from Acme Produce.",
  icon: "package",
  capabilities: ["invoices"],
  available: true,
}

function run(partial: Partial<ConnectorSyncRun> = {}): ConnectorSyncRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    providerKey: "acme",
    remoteRunId: "run_acme_1",
    status: "running",
    progress: {
      pagesDone: 1,
      documentsSeen: 4,
      documentsImported: 2,
      documentsSkipped: 0,
      linesNeedingReview: 0,
    },
    error: null,
    queuedAt: "2026-08-27T10:00:00Z",
    startedAt: "2026-08-27T10:00:01Z",
    heartbeatAt: "2026-08-27T10:00:02Z",
    finishedAt: null,
    ...partial,
  }
}

function connection(
  partial: Partial<ConnectorConnection> = {}
): ConnectorConnection {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    providerKey: "acme",
    status: "connected",
    lastSyncedAt: null,
    lastError: null,
    lastErrorCode: null,
    latestRun: null,
    ...partial,
  }
}

describe("connectorRow", () => {
  const now = new Date("2026-08-27T12:00:00Z")

  it("keeps an unconnected provider ready to connect", () => {
    expect(connectorRow(provider, null, now)).toMatchObject({
      state: "not_connected",
      primary: "connect",
      canSync: false,
    })
  })

  it("never offers a sync to a connection requiring another sign-in", () => {
    expect(
      connectorRow(
        provider,
        connection({
          status: "needs_reconnect",
          lastError: "Sign in again to continue.",
        }),
        now
      )
    ).toMatchObject({
      state: "needs_reconnect",
      primary: "reconnect",
      canSync: false,
    })
  })

  it("reports durable import progress while a run is active", () => {
    expect(
      connectorRow(provider, connection({ latestRun: run() }), now)
    ).toMatchObject({
      state: "syncing",
      statusLine: "Importing documents · 2 imported so far.",
      canSync: false,
    })
  })

  it("makes a failed run safely retryable", () => {
    expect(
      connectorRow(
        provider,
        connection({
          latestRun: run({ status: "failed", error: "Timed out" }),
        }),
        now
      )
    ).toMatchObject({
      state: "sync_failed",
      primary: "retry",
      canSync: true,
      statusLine: "Timed out",
    })
  })
})
