import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The route that keeps an uploaded receipt and hands it back to the invoice
 * page. It stores and serves raw supplier bytes, so it takes the same guards
 * as the Drive route — same-origin, session, entitlement — and one more: a key
 * names one user's file, so the session, not the query string, decides.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  putDocument: vi.fn(),
  getDocument: vi.fn(),
}))

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const KEY = `${USER}/33333333-3333-4333-8333-333333333333.pdf`

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth-session", () => ({ getSession: () => mocks.getSession() }))
vi.mock("@/lib/document-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/document-store")>(
    "@/lib/document-store"
  )
  return {
    ...actual,
    putDocument: (input: unknown) => mocks.putDocument(input),
    getDocument: (key: string) => mocks.getDocument(key),
  }
})

const { GET, POST } = await import("@/app/api/invoices/document/route")

function post(
  body: BodyInit,
  contentType = "application/pdf",
  headers: Record<string, string> = {}
) {
  return new Request("https://forkluck.test/api/invoices/document", {
    method: "POST",
    headers: {
      origin: "https://forkluck.test",
      host: "forkluck.test",
      "content-type": contentType,
      "x-file-name": "invoice.pdf",
      ...headers,
    },
    body,
  })
}

function get(query: string, headers: Record<string, string> = {}) {
  return new Request(`https://forkluck.test/api/invoices/document${query}`, {
    headers: {
      origin: "https://forkluck.test",
      host: "forkluck.test",
      ...headers,
    },
  })
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue({
    user: { id: USER },
    billing: { entitlements: { invoiceAi: true } },
  })
  mocks.putDocument.mockReset().mockResolvedValue(KEY)
  mocks.getDocument.mockReset().mockResolvedValue({
    bytes: Buffer.from("%PDF-1.4"),
    contentType: "application/pdf",
  })
})

describe("POST /api/invoices/document", () => {
  it("stores the bytes for the signed-in user and answers the key", async () => {
    const response = await POST(post(Buffer.from("%PDF-1.4")))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ key: KEY })
    expect(mocks.putDocument).toHaveBeenCalledWith({
      userId: USER,
      bytes: expect.anything(),
      contentType: "application/pdf",
      fileName: "invoice.pdf",
    })
  })

  it("refuses a type that is not a document we show", async () => {
    const response = await POST(post(Buffer.from("<html>"), "text/html"))
    expect(response.status).toBe(400)
    expect(mocks.putDocument).not.toHaveBeenCalled()
  })

  it("refuses a PDF past the cap before storing it", async () => {
    const response = await POST(post(Buffer.alloc(5_500_001)))
    expect(response.status).toBe(400)
    expect(mocks.putDocument).not.toHaveBeenCalled()
  })

  it("takes an image up to the larger image cap", async () => {
    const response = await POST(post(Buffer.alloc(7_000_000), "image/jpeg"))
    expect(response.status).toBe(200)
  })

  it("refuses a cross-origin post, a signed-out one, and one off-plan", async () => {
    expect(
      (
        await POST(
          post(Buffer.from("x"), "application/pdf", {
            origin: "https://evil.test",
          })
        )
      ).status
    ).toBe(403)

    mocks.getSession.mockResolvedValue(null)
    expect((await POST(post(Buffer.from("x")))).status).toBe(401)

    mocks.getSession.mockResolvedValue({
      user: { id: USER },
      billing: { entitlements: { invoiceAi: false } },
    })
    expect((await POST(post(Buffer.from("x")))).status).toBe(403)
    expect(mocks.putDocument).not.toHaveBeenCalled()
  })
})

describe("GET /api/invoices/document", () => {
  it("answers the bytes with a private cache", async () => {
    const response = await GET(get(`?key=${encodeURIComponent(KEY)}`))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe(
      "%PDF-1.4"
    )
  })

  it("refuses a malformed key with 400 and never reads the store", async () => {
    expect((await GET(get("?key=../../etc/passwd"))).status).toBe(400)
    expect((await GET(get(""))).status).toBe(400)
    expect(mocks.getDocument).not.toHaveBeenCalled()
  })

  it("refuses another user's key with 403", async () => {
    const response = await GET(
      get(
        `?key=${encodeURIComponent(`${OTHER}/33333333-3333-4333-8333-333333333333.pdf`)}`
      )
    )
    expect(response.status).toBe(403)
    expect(mocks.getDocument).not.toHaveBeenCalled()
  })

  it("answers 404 when the store has nothing under the key", async () => {
    mocks.getDocument.mockResolvedValue(null)
    expect((await GET(get(`?key=${encodeURIComponent(KEY)}`))).status).toBe(404)
  })
})
