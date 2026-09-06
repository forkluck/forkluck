import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ATTACHMENT_TYPES } from "@/lib/primo/attachments"
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  action: vi.fn(),
  extract: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
  get: vi.fn(),
  cleanup: vi.fn(),
}))
vi.mock("@/lib/auth-session", () => ({ getSession: mocks.session }))
vi.mock("@/lib/backend/client", () => ({ djangoAction: mocks.action }))
vi.mock("@/lib/primo/access", () => ({ primoAvailable: () => true }))
vi.mock("@/lib/document-store", () => ({
  putDocument: mocks.put,
  deleteDocument: mocks.remove,
  getDocument: mocks.get,
}))
vi.mock("@/lib/primo/attachment-server", () => ({
  extractAttachment: mocks.extract,
  readPrimoAttachment: mocks.read,
  cleanupPrimoAttachments: mocks.cleanup,
}))
import { POST, GET, DELETE } from "@/app/api/primo/attachments/route"
import { ATTACHMENT_PROCESSING_MS } from "@/lib/primo/attachments"
afterEach(() => vi.useRealTimers())
const conversationId = "00000000-0000-4000-8000-000000000001"
function upload(name: string, body = "file", origin = "https://app.test") {
  return new Request("https://internal/api/primo/attachments", {
    method: "POST",
    headers: {
      host: "app.test",
      origin,
      "x-file-name": encodeURIComponent(name),
      "x-conversation-id": conversationId,
    },
    body,
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "owner" }, billing: {} })
  mocks.remove.mockResolvedValue(undefined)
  mocks.put.mockResolvedValue("owner/key.txt")
  mocks.action.mockResolvedValue({ item: { id: conversationId } })
  mocks.extract.mockResolvedValue({ content: "200 g flour", coverage: "" })
  mocks.cleanup.mockResolvedValue(undefined)
})
describe("Primo attachment boundary", () => {
  it("streams JSON keep-alives while reading and cancels reserved storage", async () => {
    vi.useFakeTimers()
    mocks.extract.mockReturnValue(new Promise(() => {}))
    const response = await POST(upload("recipe.pdf"))
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("\n")
    await vi.advanceTimersByTimeAsync(15_000)
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("\n")
    await reader.cancel()
    expect(mocks.extract.mock.calls[0][2].aborted).toBe(true)
    expect(mocks.action).toHaveBeenCalledWith("primo-attachment", {
      operation: "remove",
      id: conversationId,
    })
    expect(mocks.remove).toHaveBeenCalledWith("owner/key.txt")
    expect(
      mocks.action.mock.calls.some(
        ([, payload]) => payload.operation === "finish"
      )
    ).toBe(false)
  })
  it("ends a stalled read with an error envelope by the total deadline", async () => {
    vi.useFakeTimers()
    mocks.extract.mockReturnValue(new Promise(() => {}))
    const response = await POST(upload("recipe.pdf"))
    const body = response.json()
    await vi.advanceTimersByTimeAsync(ATTACHMENT_PROCESSING_MS)
    expect(await body).toMatchObject({
      error: expect.stringContaining("took too long"),
    })
    expect(mocks.remove).toHaveBeenCalledWith("owner/key.txt")
  })
  it("preserves the upload quota message without exposing provider failures", async () => {
    mocks.action.mockRejectedValue(
      new Error("Too many files. Try again later.")
    )
    const response = await POST(upload("recipe.png"))
    expect(await response.json()).toEqual({
      error: "Too many files. Try again later.",
    })
    expect(mocks.extract).not.toHaveBeenCalled()
  })
  it("closes a failed read even when cleanup is stalled", async () => {
    mocks.extract.mockRejectedValue(new Error("Parser failed"))
    mocks.remove.mockReturnValue(new Promise(() => {}))
    const response = await POST(upload("recipe.pdf"))
    expect(await response.json()).toEqual({
      error: "Couldn’t read that file. Check its format and try again.",
    })
    expect(mocks.action).toHaveBeenCalledWith("primo-attachment", {
      operation: "remove",
      id: conversationId,
    })
  })
  it.each(Object.entries(ATTACHMENT_TYPES))(
    "accepts %s through the bounded extraction path",
    async (extension, type) => {
      const response = await POST(upload(`配方.${extension}`))
      expect(response.status).toBe(200)
      await response.json()
      expect(mocks.extract).toHaveBeenCalledWith(
        Buffer.from("file"),
        type,
        expect.any(AbortSignal)
      )
      expect(mocks.action.mock.calls[0]?.[1]).toMatchObject({
        operation: "create",
        name: `配方.${extension}`,
      })
      expect(mocks.action.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.extract.mock.invocationCallOrder[0]!
      )
    }
  )
  it("rejects foreign origin before session, storage or extraction", async () => {
    expect(
      (await POST(upload("recipe.txt", "file", "https://foreign.test"))).status
    ).toBe(403)
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.extract).not.toHaveBeenCalled()
  })
  it("enforces actual streamed byte size, not Content-Length", async () => {
    expect(
      (await POST(upload("recipe.pdf", "x".repeat(5_500_001)))).status
    ).toBe(400)
    expect(mocks.put).not.toHaveBeenCalled()
  })
  it("cleans a failed extraction and retains a deletion record", async () => {
    mocks.extract.mockRejectedValue(new Error("Parser failed"))
    const response = await POST(upload("recipe.docx"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      error: "Couldn’t read that file. Check its format and try again.",
    })
    expect(mocks.action).toHaveBeenCalledWith("primo-attachment", {
      operation: "remove",
      id: conversationId,
    })
    expect(mocks.remove).toHaveBeenCalledWith("owner/key.txt")
  })
  it("does not infer when attachment ownership admission fails", async () => {
    mocks.action.mockRejectedValue(new Error("Conversation not found"))
    expect((await POST(upload("recipe.png"))).status).toBe(400)
    expect(mocks.extract).not.toHaveBeenCalled()
  })
  it("refuses expired or foreign downloads before blob access", async () => {
    mocks.read.mockRejectedValue(new Error("Not found"))
    expect(
      (
        await GET(
          new Request(
            `https://app.test/api/primo/attachments?id=${conversationId}&conversationId=${conversationId}`
          )
        )
      ).status
    ).toBe(404)
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it("guards removal with the same origin check", async () => {
    expect(
      (
        await DELETE(
          new Request("https://app.test/api/primo/attachments", {
            method: "DELETE",
          })
        )
      ).status
    ).toBe(403)
    expect(mocks.action).not.toHaveBeenCalled()
  })
})
