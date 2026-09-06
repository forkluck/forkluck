import "server-only"

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob"

/**
 * Where an uploaded invoice document lives after the import that read it, so
 * the invoice page can show the file beside its lines the way a Drive-folder
 * invoice already does. A Drive file is never stored here — it stays in the
 * merchant's own folder and is fetched by id.
 *
 * Azure Blob when `AZURE_STORAGE_CONNECTION_STRING` is set, a directory on
 * disk otherwise, which is the self-hosted default.
 */

/** Raw bytes per kind, matching the dialog's client-side caps
 *  (`MAX_PDF_BYTES` / `MAX_IMAGE_BYTES` in `components/invoices/receipt-state`
 *  — duplicated rather than imported, because that module is client code). */
export const DOCUMENT_MAX_PDF_BYTES = 5_500_000
export const DOCUMENT_MAX_IMAGE_BYTES = 8_000_000

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

/** User ids are UUIDs, so a key is two fixed shapes and a known extension:
 *  nothing that reaches the filesystem can walk out of the store directory. */
const KEY =
  /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|webp|txt|csv|xlsx|docx)$/

/** Whether the string is a key at all — the shape check, without ownership. */
export function isDocumentKey(key: string): boolean {
  return KEY.test(key)
}

export function isDocumentKeyOf(key: string, userId: string): boolean {
  return KEY.test(key) && key.startsWith(`${userId}/`)
}

function extensionOf(contentType: string): string {
  const extension = EXTENSIONS[contentType]
  if (!extension) {
    throw new Error(`Unsupported document type: ${contentType}`)
  }
  return extension
}

function contentTypeOf(key: string): string {
  return (
    CONTENT_TYPES[key.slice(key.lastIndexOf(".") + 1)] ??
    "application/octet-stream"
  )
}

let container: Promise<ContainerClient> | null = null

async function azureContainer(connectionString: string) {
  if (!container) {
    container = (async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob")
      const service: BlobServiceClient =
        BlobServiceClient.fromConnectionString(connectionString)
      const client = service.getContainerClient(
        process.env.AZURE_STORAGE_CONTAINER || "documents"
      )
      await client.createIfNotExists()
      return client
    })()
  }
  return container
}

// A plain string, relative to the working directory by default: Next's build
// traces every `path.join` it can partly resolve, and one joined with a key
// it cannot see made it copy the whole project into the standalone server.
function diskPath(key: string): string {
  const configured = process.env.DOCUMENT_STORE_DIR
  return `${configured || ".forkluck/documents"}/${key}`
}

export async function putDocument(input: {
  userId: string
  bytes: Buffer | Uint8Array
  contentType: string
  fileName: string
}): Promise<string> {
  const key = `${input.userId}/${randomUUID()}.${extensionOf(input.contentType)}`
  const bytes = Buffer.from(input.bytes)
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (connectionString) {
    const client = await azureContainer(connectionString)
    await client.getBlockBlobClient(key).uploadData(bytes, {
      blobHTTPHeaders: {
        blobContentType: input.contentType,
        // The name the merchant's own file had, for anyone reading the store.
        blobContentDisposition: `inline; filename="${input.fileName.replace(/[^\w. -]/g, "_")}"`,
      },
    })
    return key
  }
  const file = diskPath(key)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
  return key
}

export async function getDocument(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!KEY.test(key)) return null
  const contentType = contentTypeOf(key)
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (connectionString) {
    const client = await azureContainer(connectionString)
    const blob = client.getBlockBlobClient(key)
    if (!(await blob.exists())) return null
    return { bytes: await blob.downloadToBuffer(), contentType }
  }
  try {
    return { bytes: await readFile(diskPath(key)), contentType }
  } catch {
    return null
  }
}

export async function deleteDocument(key: string): Promise<void> {
  if (!KEY.test(key)) return
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (connectionString) {
    const client = await azureContainer(connectionString)
    await client.getBlockBlobClient(key).deleteIfExists()
    return
  }
  await rm(diskPath(key), { force: true })
}
