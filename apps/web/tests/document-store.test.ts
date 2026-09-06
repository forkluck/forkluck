import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { beforeAll, describe, expect, it, vi } from "vitest"

/**
 * The disk backend, which is what a self-hosted install runs. A key names one
 * user's file: the store must refuse anything that is not exactly the shape it
 * writes, because the key reaches the filesystem.
 */

vi.mock("server-only", () => ({}))

const root = await mkdtemp(path.join(tmpdir(), "forkluck-documents-"))
process.env.DOCUMENT_STORE_DIR = root
delete process.env.AZURE_STORAGE_CONNECTION_STRING

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

let store: typeof import("@/lib/document-store")

beforeAll(async () => {
  store = await import("@/lib/document-store")
})

describe("putDocument", () => {
  it("writes under <userId>/<uuid>.<ext> and reads the bytes back", async () => {
    const key = await store.putDocument({
      userId: USER,
      bytes: Buffer.from("%PDF-1.4"),
      contentType: "application/pdf",
      fileName: "invoice.pdf",
    })
    expect(key).toMatch(
      /^11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}\.pdf$/
    )
    expect(await readFile(path.join(root, key), "utf8")).toBe("%PDF-1.4")

    const read = await store.getDocument(key)
    expect(read?.contentType).toBe("application/pdf")
    expect(read?.bytes.toString("utf8")).toBe("%PDF-1.4")
  })

  it("names the extension from the content type", async () => {
    const key = await store.putDocument({
      userId: USER,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    })
    expect(key.endsWith(".jpg")).toBe(true)
    expect((await store.getDocument(key))?.contentType).toBe("image/jpeg")
  })

  it("refuses a type the store has no extension for", async () => {
    await expect(
      store.putDocument({
        userId: USER,
        bytes: Buffer.from("x"),
        contentType: "text/html",
        fileName: "page.html",
      })
    ).rejects.toThrow(/Unsupported/)
  })
})

describe("getDocument", () => {
  it("answers null for a key nothing was written under", async () => {
    expect(
      await store.getDocument(
        `${USER}/33333333-3333-4333-8333-333333333333.pdf`
      )
    ).toBeNull()
  })

  it("answers null for a key that could walk out of the store", async () => {
    expect(await store.getDocument(`${USER}/../../etc/passwd`)).toBeNull()
    // No directory was created for the traversal attempt either.
    expect(await readdir(root)).toEqual([USER])
  })
})

describe("deleteDocument", () => {
  it("removes the file and is quiet about one already gone", async () => {
    const key = await store.putDocument({
      userId: USER,
      bytes: Buffer.from("gone"),
      contentType: "image/png",
      fileName: "photo.png",
    })
    await store.deleteDocument(key)
    expect(await store.getDocument(key)).toBeNull()
    await expect(store.deleteDocument(key)).resolves.toBeUndefined()
  })
})

describe("isDocumentKeyOf", () => {
  it("accepts only this user's well-formed key", () => {
    const key = `${USER}/44444444-4444-4444-8444-444444444444.pdf`
    expect(store.isDocumentKeyOf(key, USER)).toBe(true)
    expect(store.isDocumentKeyOf(key, OTHER)).toBe(false)
    expect(store.isDocumentKeyOf(`${USER}/../${OTHER}/x.pdf`, USER)).toBe(false)
    expect(store.isDocumentKeyOf(`${USER}/whatever.pdf`, USER)).toBe(false)
    expect(
      store.isDocumentKeyOf(
        `${USER}/44444444-4444-4444-8444-444444444444.exe`,
        USER
      )
    ).toBe(false)
    expect(store.isDocumentKeyOf("", USER)).toBe(false)
  })
})
