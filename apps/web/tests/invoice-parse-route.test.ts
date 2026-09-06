import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/import-limits"

/**
 * The parse route's body union.
 *
 * The two arms are not interchangeable: an upload carries bytes, while a file
 * from the connected Drive folder carries only its id — the server fetches it
 * and reads its MIME and size from Drive. A body that describes neither, or
 * one whose bytes are past the cap, must be refused before anything is
 * fetched or extracted, because extraction bills the merchant's own AI key.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  runInvoiceParse: vi.fn(),
}))

vi.mock("server-only", () => ({}))
// Reached only through `import-limits`; the route reads no workbook.
vi.mock("xlsx", () => ({ utils: {} }))
vi.mock("@/lib/auth-session", () => ({ getSession: () => mocks.getSession() }))
vi.mock("@/lib/invoice-parse", () => ({
  runInvoiceParse: (input: unknown) => mocks.runInvoiceParse(input),
}))

const { POST } = await import("@/app/api/invoices/parse/route")

function request(body: unknown) {
  return new Request("https://forkluck.test/api/invoices/parse", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://forkluck.test",
      host: "forkluck.test",
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue({
    user: { id: "user-1" },
    billing: { entitlements: { invoiceAi: true } },
  })
  mocks.runInvoiceParse
    .mockReset()
    .mockResolvedValue({ documents: [{ fileName: "ok.pdf" }] })
})

afterEach(() => vi.useRealTimers())

describe("POST /api/invoices/parse", () => {
  it("fits the largest accepted photo and its metadata through nginx", async () => {
    const input = {
      base64: Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES).toString("base64"),
      fileName: `${"é".repeat(250)}.jpg`,
      mediaType: "image/jpeg",
      driveFileId: null,
      driveWebViewLink: null,
    }
    const proxy = readFileSync(
      new URL("../../../deploy/nginx/forkluck.conf", import.meta.url),
      "utf8"
    )
    const limit =
      Number(proxy.match(/client_max_body_size\s+(\d+)M;/)?.[1]) * 1024 * 1024
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(limit)
    expect((await POST(request(input))).status).toBe(200)
    expect(mocks.runInvoiceParse).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      base64: "ZmFrZQ==",
      fileName: "scan.pdf",
      driveFileId: null,
      driveWebViewLink: null,
    },
    { fileName: "scan.pdf", driveFileId: "drive-1", driveWebViewLink: null },
  ])(
    "keeps a long read alive and returns its JSON unchanged: $driveFileId",
    async (input) => {
      vi.useFakeTimers()
      let finish!: (result: unknown) => void
      mocks.runInvoiceParse.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const response = await POST(request(input))
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("x-accel-buffering")).toBe("no")
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let body = decoder.decode((await reader.read()).value)
      expect(body).toBe("\n")
      // Cross the production proxy's 120s deadline while the AI is unresolved.
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(15_000)
        const chunk = decoder.decode((await reader.read()).value)
        expect(chunk).toBe("\n")
        body += chunk
      }
      const result = {
        documents: [
          {
            lines: [
              {
                position: 1,
                box: { page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.3 },
              },
            ],
          },
        ],
      }
      finish(result)
      body += decoder.decode((await reader.read()).value)
      expect((await reader.read()).done).toBe(true)
      expect(JSON.parse(body)).toEqual(result)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it("closes the heartbeat with a JSON error when a read rejects", async () => {
    vi.useFakeTimers()
    mocks.runInvoiceParse.mockRejectedValue(
      new Error("private provider details")
    )
    const response = await POST(
      request({
        driveFileId: "drive-1",
        fileName: "scan.pdf",
        driveWebViewLink: null,
      })
    )
    expect(await response.json()).toEqual({
      error: "Couldn't read that file. Please try again.",
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops heartbeats when the response is cancelled, even if the read finishes later", async () => {
    vi.useFakeTimers()
    let finish!: (result: unknown) => void
    mocks.runInvoiceParse.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const response = await POST(
      request({
        driveFileId: "drive-1",
        fileName: "scan.pdf",
        driveWebViewLink: null,
      })
    )
    await response.body!.cancel()
    expect(vi.getTimerCount()).toBe(0)
    finish({ documents: [] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([null, { billing: { entitlements: { invoiceAi: false } } }])(
    "does not begin a stream for a refused session %j",
    async (session) => {
      vi.useFakeTimers()
      mocks.getSession.mockResolvedValue(session)
      const response = await POST(
        request({
          driveFileId: "drive-1",
          fileName: "scan.pdf",
          driveWebViewLink: null,
        })
      )
      expect(response.status).toBe(session ? 403 : 401)
      expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it("refuses a different origin before starting a read", async () => {
    const input = request({
      driveFileId: "drive-1",
      fileName: "scan.pdf",
      driveWebViewLink: null,
    })
    input.headers.set("origin", "https://another.test")
    expect((await POST(input)).status).toBe(403)
    expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
  })

  it("passes uploaded bytes through as a PDF file", async () => {
    const response = await POST(
      request({
        base64: "ZmFrZQ==",
        fileName: "invoice.pdf",
        driveFileId: null,
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(200)
    // One file, a list of documents: a scanned bundle answers several.
    expect(await response.json()).toEqual({
      documents: [{ fileName: "ok.pdf" }],
    })
    expect(mocks.runInvoiceParse).toHaveBeenCalledWith({
      file: {
        kind: "pdf",
        mediaType: "application/pdf",
        base64: "ZmFrZQ==",
      },
      fileName: "invoice.pdf",
      driveFileId: null,
      driveWebViewLink: null,
    })
  })

  it("sends a Drive file with no bytes, so MIME and size come from Drive", async () => {
    const response = await POST(
      request({
        driveFileId: "drive-1",
        fileName: "IV101-123.pdf",
        driveWebViewLink: "https://drive.google.com/file/d/drive-1/view",
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.runInvoiceParse).toHaveBeenCalledWith({
      file: null,
      fileName: "IV101-123.pdf",
      driveFileId: "drive-1",
      driveWebViewLink: "https://drive.google.com/file/d/drive-1/view",
    })
  })

  it("refuses a body with neither bytes nor a Drive file", async () => {
    const response = await POST(
      request({ fileName: "invoice.pdf", driveWebViewLink: null })
    )
    expect(response.status).toBe(400)
    expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
  })

  it("passes an uploaded photo through as an image file", async () => {
    const response = await POST(
      request({
        base64: "ZmFrZQ==",
        mediaType: "image/jpeg",
        fileName: "IMG_1584.jpg",
        driveFileId: null,
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(200)
    expect(mocks.runInvoiceParse).toHaveBeenCalledWith({
      file: { kind: "image", mediaType: "image/jpeg", base64: "ZmFrZQ==" },
      fileName: "IMG_1584.jpg",
      driveFileId: null,
      driveWebViewLink: null,
    })
  })

  it("refuses a media type the pipeline can't read", async () => {
    const response = await POST(
      request({
        base64: "ZmFrZQ==",
        mediaType: "image/heic",
        fileName: "IMG_1584.heic",
        driveFileId: null,
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
  })

  // A photo is allowed more bytes than a PDF, and the two caps are enforced
  // per kind — an oversized PDF must not slip through on the image ceiling,
  // nor fall back into the Drive arm and be fetched instead.
  it("refuses a PDF past the PDF cap", async () => {
    const response = await POST(
      request({
        base64: "A".repeat(8_000_001),
        fileName: "invoice.pdf",
        driveFileId: "drive-1",
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
  })

  it("accepts a photo past the PDF cap", async () => {
    const response = await POST(
      request({
        base64: "A".repeat(8_000_001),
        mediaType: "image/jpeg",
        fileName: "IMG_1584.jpg",
        driveFileId: null,
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(200)
  })

  it("refuses bytes past the image cap", async () => {
    const response = await POST(
      request({
        base64: "A".repeat(10_666_669),
        mediaType: "image/jpeg",
        fileName: "IMG_1584.jpg",
        driveFileId: null,
        driveWebViewLink: null,
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.runInvoiceParse).not.toHaveBeenCalled()
  })
})
