import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  listPrimoConversations,
  loadPrimoConversation,
} from "@/lib/primo/conversations"

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}))
vi.mock("@/lib/auth-session", () => ({ getSession: mocks.session }))
vi.mock("@/lib/backend/queries", () => ({
  listPrimoConversations: mocks.list,
  getPrimoConversation: mocks.get,
}))
const { GET } = await import("@/app/api/primo/conversations/route")
const id = "00000000-0000-4000-8000-000000000001"
const date = "2026-09-05T19:00:00.000Z"
const row = {
  id,
  title: "Synthetic recipe",
  isArchived: false,
  createdAt: date,
  updatedAt: date,
  lastMessageAt: date,
  archivedAt: null,
}
function request(query = "") {
  return new Request(`https://forkluck.test/api/primo/conversations?${query}`)
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "owner" } })
})
afterEach(() => vi.unstubAllGlobals())

describe("stable conversation reads", () => {
  it("requires authentication before any transcript query", async () => {
    mocks.session.mockResolvedValue(null)
    expect((await GET(request())).status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it.each([
    "id=foreign",
    "page=0",
    "page=NaN",
    "archived=true",
    `q=${"x".repeat(201)}`,
  ])("rejects malformed filters: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it("uses the existing owner-scoped query with bounded filters and forbids caching", async () => {
    mocks.list.mockResolvedValue({ items: [row], meta: {} })
    const response = await GET(request("page=2&archived=1&q=stock"))
    expect(response.status).toBe(200)
    expect(mocks.list).toHaveBeenCalledWith({
      page: 2,
      limit: 50,
      archived: true,
      query: "stock",
    })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect((await response.json()).items).toEqual([row])
  })
  it("returns the same not-found envelope for unavailable or foreign conversations", async () => {
    mocks.get.mockResolvedValue(null)
    const response = await GET(request(`id=${id}`))
    expect(mocks.get).toHaveBeenCalledWith(id)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Conversation not found" })
  })
  it("does not leak backend failure details", async () => {
    mocks.list.mockRejectedValue(new Error("private backend details"))
    const response = await GET(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: "Couldn’t load recent chats.",
    })
  })
  it("reads over HTTP without a build-specific action ID and revives summary dates", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [row], meta: { pagination: { next: null } } })
      )
    vi.stubGlobal("fetch", fetch)
    const result = await listPrimoConversations({
      page: 2,
      archived: true,
      query: "stock & beans",
    })
    expect(fetch).toHaveBeenCalledWith(
      "/api/primo/conversations?page=2&archived=1&q=stock+%26+beans",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      })
    )
    expect(result).toHaveProperty("items.0.createdAt", new Date(date))
    expect(result).toHaveProperty("items.0.archivedAt", null)
  })
  it("revives transcript timestamps without changing tool payloads or message metadata", async () => {
    const message = {
      id: "answer",
      role: "assistant",
      createdAt: date,
      status: "error",
      metadata: { createdAt: date },
      parts: [
        {
          type: "tool-draft_recipe",
          state: "input-streaming",
          input: { createdAt: "source data" },
        },
      ],
    }
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ item: { conversation: row, messages: [message] } })
        )
    )
    const result = await loadPrimoConversation(id)
    expect(result).toHaveProperty("item.messages.0.createdAt", new Date(date))
    expect(result).toHaveProperty("item.messages.0.metadata", message.metadata)
    expect(result).toHaveProperty("item.messages.0.parts", message.parts)
  })
  it.each([401, 404, 502])("preserves error envelopes (%s)", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Conversation not found" }, { status })
        )
    )
    expect(await loadPrimoConversation(id)).toEqual({
      error: "Conversation not found",
    })
  })
  it("makes a lost connection retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    expect(await listPrimoConversations()).toEqual({
      error: expect.stringMatching(/try again/),
    })
  })
})
