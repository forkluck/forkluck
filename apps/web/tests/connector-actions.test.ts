import { beforeEach, describe, expect, it, vi } from "vitest"

const sent: Array<{ slug: string; body: Record<string, unknown> }> = []
const revalidated: string[] = []
const replies: unknown[] = []
const getConnectorSyncRun = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidated.push(path),
}))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({ id: "user_1" }),
}))
vi.mock("@/lib/backend/queries", () => ({ getConnectorSyncRun }))
vi.mock("@/lib/invoice-extract", () => ({
  verifyAnthropicKey: () => Promise.resolve({}),
}))
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction: (slug: string, body: Record<string, unknown>) => {
    sent.push({ slug, body })
    return Promise.resolve(replies.shift())
  },
}))

const {
  completeConnectorAuthorization,
  connectConnector,
  disconnectConnector,
  enqueueConnectorSync,
  loadConnectorSyncRun,
} = await import("@/app/(app)/invoices/actions")

beforeEach(() => {
  sent.length = 0
  revalidated.length = 0
  replies.length = 0
  getConnectorSyncRun.mockReset()
})

describe("supplier connector actions", () => {
  it("starts a provider-hosted authorization session from only a provider key", async () => {
    replies.push({ authorizationUrl: "https://connectors.example/authorize" })

    expect(await connectConnector("acme")).toEqual({
      authorizationUrl: "https://connectors.example/authorize",
    })
    expect(sent).toEqual([
      { slug: "connect-connector", body: { providerKey: "acme" } },
    ])
    expect(revalidated).toEqual([])
  })

  it("exchanges only the short-lived callback values and revalidates catalog reads", async () => {
    replies.push({ connection: { id: "connection_1" } })

    await completeConnectorAuthorization({ state: "s".repeat(16), code: "c1" })

    expect(sent).toEqual([
      {
        slug: "complete-connector-authorization",
        body: { state: "s".repeat(16), code: "c1" },
      },
    ])
    expect(revalidated.sort()).toEqual([
      "/integrations/suppliers/activity",
      "/integrations/suppliers/connections",
      "/invoices",
    ])
  })

  it("uses the local connection id for manual sync and disconnect", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    replies.push({ run: { id: "run_1" } }, { ok: true })

    await enqueueConnectorSync(id)
    await disconnectConnector(id)

    expect(sent).toEqual([
      { slug: "enqueue-connector-sync", body: { connectionId: id } },
      { slug: "disconnect-connector", body: { connectionId: id } },
    ])
    expect(revalidated).toEqual([
      "/invoices",
      "/integrations/suppliers/connections",
      "/integrations/suppliers/activity",
      "/invoices",
      "/integrations/suppliers/connections",
      "/integrations/suppliers/activity",
    ])
  })

  it("refuses malformed public identifiers before sending a service request", async () => {
    expect(await connectConnector("bad/provider")).toEqual({
      error: "Unknown supplier connector.",
    })
    expect(await enqueueConnectorSync("not-a-uuid")).toEqual({
      error: "Unknown supplier connection.",
    })
    expect(sent).toEqual([])
  })

  it("loads progress through the tenant-scoped backend query", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const run = { id, status: "running" }
    getConnectorSyncRun.mockResolvedValue(run)

    await expect(loadConnectorSyncRun(id)).resolves.toEqual(run)
    expect(getConnectorSyncRun).toHaveBeenCalledWith(id)
  })
})
