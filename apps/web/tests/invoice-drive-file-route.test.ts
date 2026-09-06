import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The route that streams a connected-folder document back to the review pane.
 *
 * It hands out raw supplier bytes, so every guard the parse route applies
 * applies here too — and one more that matters most: the service account can
 * read every folder shared with it, so a file id alone must never be enough.
 * The folder this workspace connected is the authorization.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDriveFolder: vi.fn(),
  assertFileInFolder: vi.fn(),
  fetchDriveFileBytes: vi.fn(),
}))

class DriveServiceError extends Error {}

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth-session", () => ({ getSession: () => mocks.getSession() }))
vi.mock("@/lib/backend/queries", () => ({
  getDriveFolder: () => mocks.getDriveFolder(),
}))
vi.mock("@/lib/google-drive-service", () => ({
  DriveServiceError,
  assertFileInFolder: (fileId: string, folderId: string) =>
    mocks.assertFileInFolder(fileId, folderId),
  fetchDriveFileBytes: (fileId: string, maxBytes: (mime: string) => number) =>
    mocks.fetchDriveFileBytes(fileId, maxBytes),
}))

const { GET } = await import("@/app/api/invoices/drive-file/route")

function request(query: string, headers: Record<string, string> = {}) {
  return new Request(`https://forkluck.test/api/invoices/drive-file${query}`, {
    headers: {
      origin: "https://forkluck.test",
      host: "forkluck.test",
      ...headers,
    },
  })
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue({
    user: { id: "user-1" },
    billing: { entitlements: { invoiceAi: true } },
  })
  mocks.getDriveFolder
    .mockReset()
    .mockResolvedValue({ folder: { folderId: "folder-1" } })
  mocks.assertFileInFolder.mockReset().mockResolvedValue(undefined)
  mocks.fetchDriveFileBytes.mockReset().mockResolvedValue({
    base64: Buffer.from("%PDF-1.4").toString("base64"),
    mimeType: "application/pdf",
    bytes: 8,
  })
})

describe("GET /api/invoices/drive-file", () => {
  it("streams the bytes with Drive's MIME and no stored copy", async () => {
    const response = await GET(request("?id=drive-1"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-disposition")).toBe("inline")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.text()).toBe("%PDF-1.4")
    expect(mocks.assertFileInFolder).toHaveBeenCalledWith("drive-1", "folder-1")
  })

  it("refuses a cross-origin request", async () => {
    const response = await GET(
      request("?id=drive-1", { origin: "https://evil.test" })
    )
    expect(response.status).toBe(403)
    expect(mocks.fetchDriveFileBytes).not.toHaveBeenCalled()
  })

  it("refuses a signed-out request", async () => {
    mocks.getSession.mockResolvedValue(null)
    const response = await GET(request("?id=drive-1"))
    expect(response.status).toBe(401)
    expect(mocks.fetchDriveFileBytes).not.toHaveBeenCalled()
  })

  it("refuses a workspace whose plan doesn't include invoice reading", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1" },
      billing: { entitlements: { invoiceAi: false } },
    })
    const response = await GET(request("?id=drive-1"))
    expect(response.status).toBe(403)
    expect(mocks.fetchDriveFileBytes).not.toHaveBeenCalled()
  })

  it("refuses a request with no file id", async () => {
    const response = await GET(request(""))
    expect(response.status).toBe(400)
    expect(mocks.fetchDriveFileBytes).not.toHaveBeenCalled()
  })

  it("refuses a file outside the connected folder before fetching it", async () => {
    mocks.assertFileInFolder.mockRejectedValue(
      new DriveServiceError("That file isn't in the connected Drive folder.")
    )
    const response = await GET(request("?id=someone-elses-file"))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: "That file isn't in the connected Drive folder.",
    })
    expect(mocks.fetchDriveFileBytes).not.toHaveBeenCalled()
  })

  it("refuses when no folder is connected", async () => {
    mocks.getDriveFolder.mockResolvedValue({ folder: null })
    const response = await GET(request("?id=drive-1"))
    expect(response.status).toBe(404)
    expect(mocks.assertFileInFolder).not.toHaveBeenCalled()
  })

  it("caps a photo and a PDF at their own sizes", async () => {
    mocks.fetchDriveFileBytes.mockResolvedValue({
      base64: Buffer.from("jpeg").toString("base64"),
      mimeType: "image/jpeg",
      bytes: 4,
    })
    const response = await GET(request("?id=drive-1"))
    expect(response.headers.get("content-type")).toBe("image/jpeg")
    const maxBytes = mocks.fetchDriveFileBytes.mock.calls[0][1] as (
      mime: string
    ) => number
    expect(maxBytes("application/pdf")).toBe(5_500_000)
    expect(maxBytes("image/jpeg")).toBe(7_000_000)
  })
})
