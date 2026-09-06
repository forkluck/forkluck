import "server-only"

import { createSign } from "node:crypto"

import type { DriveFile } from "@/lib/drive-folder"

/**
 * Read-only Drive access through a service account, the way a data connector
 * does it: the merchant shares one folder with the account's address, so there
 * is no consent screen, no refresh token, and nothing to re-authorize.
 *
 * The credential is server-only and never reaches the browser — neither the
 * key nor an access token minted from it. The account can read *every* folder
 * shared with it, across workspaces, so a file id from a client is not
 * authorization: {@link assertFileInFolder} checks ancestry against the
 * folder that workspace connected before any byte is fetched.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const DRIVE_API = "https://www.googleapis.com/drive/v3/files"
const DRIVE_CHANGES = "https://www.googleapis.com/drive/v3/changes"
const SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink"
/** Month folders one level under the folder root; four covers a stray nest. */
const MAX_DEPTH = 4
const MAX_FILES = 2000

type ServiceAccountKey = { client_email: string; private_key: string }

export class DriveServiceError extends Error {}

/** Google has dropped the Changes cursor — it is older than Drive keeps, or
 * it was never valid. The only cure is a fresh start token and a full listing,
 * so the watcher tells this apart from every other Drive failure. */
export class DriveCursorExpiredError extends DriveServiceError {}

function credential(): ServiceAccountKey {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!encoded) {
    throw new DriveServiceError("Google Drive isn't configured on this server.")
  }
  let key: ServiceAccountKey
  try {
    key = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  } catch {
    // Deliberately says nothing about the value itself.
    throw new DriveServiceError("The Google service account key is unreadable.")
  }
  if (!key.client_email || !key.private_key) {
    throw new DriveServiceError("The Google service account key is unreadable.")
  }
  return key
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url")
}

let cachedToken: { token: string; expiresAt: number } | null = null

/** A signed JWT traded for an access token, cached until a minute before it
 * expires. */
export async function getServiceAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now())
    return cachedToken.token
  const key = credential()
  const issued = Math.floor(Date.now() / 1000)
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  }
  const signing = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify(claims)
  )}`
  const signature = base64Url(
    createSign("RSA-SHA256").update(signing).sign(key.private_key)
  )

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signing}.${signature}`,
    }),
  })
  if (!response.ok) {
    throw new DriveServiceError(
      "Google refused the service account credential."
    )
  }
  const body = (await response.json()) as {
    access_token?: string
    expires_in?: number
  }
  if (!body.access_token) {
    throw new DriveServiceError(
      "Google refused the service account credential."
    )
  }
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  }
  return cachedToken.token
}

async function driveFetch(url: string): Promise<Response> {
  const token = await getServiceAccessToken()
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } })
}

function driveGet(path: string): Promise<Response> {
  return driveFetch(`${DRIVE_API}${path}`)
}

async function driveJson<T>(path: string, notFound: string): Promise<T> {
  const response = await driveGet(path)
  if (response.status === 404 || response.status === 403) {
    throw new DriveServiceError(notFound)
  }
  if (!response.ok) {
    throw new DriveServiceError(`Google Drive failed (${response.status}).`)
  }
  return (await response.json()) as T
}

type DriveFileResource = {
  id: string
  name?: string
  mimeType?: string
  size?: string
  modifiedTime?: string
  webViewLink?: string
  parents?: string[]
  trashed?: boolean
}

function driveFile(resource: DriveFileResource): DriveFile {
  return {
    id: resource.id,
    name: resource.name ?? "file",
    mimeType: resource.mimeType ?? "",
    sizeBytes: resource.size ? Number(resource.size) : null,
    webViewLink:
      resource.webViewLink ??
      `https://drive.google.com/file/d/${resource.id}/view`,
  }
}

const NOT_IN_FOLDER = "That file isn't in the connected Drive folder."

const SHARE_HINT =
  "Forkluck can't see that folder. Share it with the service account address and try again."

/** Proves the folder exists and is shared with the service account. */
export async function getFolderMeta(
  folderId: string
): Promise<{ id: string; name: string }> {
  const resource = await driveJson<DriveFileResource>(
    `/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`,
    SHARE_HINT
  )
  if (resource.mimeType !== "application/vnd.google-apps.folder") {
    throw new DriveServiceError("That link points at a file, not a folder.")
  }
  return { id: resource.id, name: resource.name ?? "Drive folder" }
}

/** A file as the folder listing found it: where it sits, and when Drive last
 * saw it change, which is what the registry stores alongside the id. */
export type DriveListedFile = DriveFile & {
  modifiedTime: string | null
  /** Sub-folder path under the connected folder; "" at its root. */
  folderPath: string
}

/**
 * Every file under the folder, breadth-first. Folders whose name starts with
 * `_` are the merchant's own working material (`_source-bundles`) and are
 * skipped whole.
 */
export async function listDriveFolder(
  folderId: string
): Promise<DriveListedFile[]> {
  const files: DriveListedFile[] = []
  let level = [{ id: folderId, path: "" }]
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: Array<{ id: string; path: string }> = []
    for (const parent of level) {
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          q: `'${parent.id}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        })
        if (pageToken) params.set("pageToken", pageToken)
        const page = await driveJson<{
          files?: DriveFileResource[]
          nextPageToken?: string
        }>(`?${params}`, SHARE_HINT)
        for (const resource of page.files ?? []) {
          if (resource.mimeType === "application/vnd.google-apps.folder") {
            const name = resource.name ?? ""
            if (!name.startsWith("_")) {
              next.push({
                id: resource.id,
                path: parent.path ? `${parent.path}/${name}` : name,
              })
            }
            continue
          }
          if (files.length >= MAX_FILES) return files
          files.push({
            ...driveFile(resource),
            modifiedTime: resource.modifiedTime ?? null,
            folderPath: parent.path,
          })
        }
        pageToken = page.nextPageToken
      } while (pageToken)
    }
    level = next
  }
  return files
}

/** Where a file sits relative to the connected folder that owns it.
 * `excluded` is a `_`-prefixed folder on the way up: the merchant's own
 * working material, which the listing skips and the registry drops. */
export type DriveAncestor = {
  folderId: string
  folderPath: string
  excluded: boolean
}

/** One poll's folder lookups, so a page of changes out of the same month
 * folder costs one `files.get` rather than one per file per level. */
export type DriveAncestorCache = Map<
  string,
  { name: string; parent: string | null }
>

/**
 * Which connected folder a file belongs to, walking up its parents. The
 * service account reads every folder shared with it, so this is what decides
 * the workspace a changed file registers against — and, for one file id, what
 * proves it may be fetched at all.
 */
export async function resolveDriveAncestor(
  parents: string[],
  folderIds: ReadonlySet<string>,
  cache: DriveAncestorCache
): Promise<DriveAncestor | null> {
  let current: string | null = parents[0] ?? null
  const names: string[] = []
  let excluded = false
  for (let depth = 0; current !== null && depth <= MAX_DEPTH; depth += 1) {
    const parent: string = current
    if (folderIds.has(parent)) {
      return {
        folderId: parent,
        folderPath: names.reverse().join("/"),
        excluded,
      }
    }
    let folder = cache.get(parent)
    if (!folder) {
      const resource = await driveJson<DriveFileResource>(
        `/${encodeURIComponent(parent)}?fields=id,name,parents&supportsAllDrives=true`,
        NOT_IN_FOLDER
      )
      folder = {
        name: resource.name ?? "",
        parent: resource.parents?.[0] ?? null,
      }
      cache.set(parent, folder)
    }
    if (folder.name.startsWith("_")) excluded = true
    names.push(folder.name)
    current = folder.parent
  }
  return null
}

/**
 * Refuse a file that is not inside the connected folder. The service account
 * reads every folder shared with it, so this — not the file id — is what
 * scopes a fetch to the workspace that asked for it.
 */
export async function assertFileInFolder(
  fileId: string,
  folderId: string
): Promise<void> {
  const resource = await driveJson<DriveFileResource>(
    `/${encodeURIComponent(fileId)}?fields=id,parents&supportsAllDrives=true`,
    NOT_IN_FOLDER
  )
  const ancestor = await resolveDriveAncestor(
    resource.parents ?? [],
    new Set([folderId]),
    new Map()
  )
  if (!ancestor || ancestor.excluded) {
    throw new DriveServiceError(NOT_IN_FOLDER)
  }
}

/** The bytes, plus the MIME and size Drive itself reports — never the ones a
 * client claimed. The cap is a function of that MIME because a PDF and a photo
 * are allowed different sizes. */
export async function fetchDriveFileBytes(
  fileId: string,
  maxBytes: (mimeType: string) => number
): Promise<{ base64: string; mimeType: string; bytes: number }> {
  const meta = await driveJson<DriveFileResource>(
    `/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
    "That file is no longer in Drive."
  )
  const limit = maxBytes(meta.mimeType ?? "")
  const declared = meta.size ? Number(meta.size) : null
  if (declared !== null && declared > limit) {
    throw new DriveServiceError("That file is too large to read.")
  }
  const response = await driveGet(
    `/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
  )
  if (!response.ok) {
    throw new DriveServiceError(`Google Drive failed (${response.status}).`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > limit) {
    throw new DriveServiceError("That file is too large to read.")
  }
  return {
    base64: buffer.toString("base64"),
    mimeType: meta.mimeType ?? "",
    bytes: buffer.byteLength,
  }
}

/* -------------------------------------------------------------------------- */
/* Changes feed                                                               */
/* -------------------------------------------------------------------------- */

// One cursor covers everything shared with the service account, so the
// watcher polls once for the whole installation and sorts each changed file
// to a workspace by ancestry.

const CHANGE_FIELDS =
  "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed))"

/** One page of the changes listing, which always names a cursor. */
async function changesJson<T>(params: URLSearchParams): Promise<T> {
  const response = await driveFetch(`${DRIVE_CHANGES}?${params}`)
  if (response.ok) return (await response.json()) as T
  // Drive answers 410 for a cursor it no longer keeps, and 400 for one it
  // never issued. Both mean the same thing to the watcher: start over.
  const body = response.status === 400 ? await response.text() : ""
  if (response.status === 410 || /page ?token/i.test(body)) {
    throw new DriveCursorExpiredError("The Drive change cursor has expired.")
  }
  throw new DriveServiceError(`Google Drive failed (${response.status}).`)
}

/**
 * A cursor covering everything from now on. What the watcher takes when it
 * has none, and again when Google drops the one it had.
 *
 * Its own endpoint, deliberately: the listing above refuses a request without
 * a cursor with a 400 that names `pageToken`, which reads exactly like a
 * dropped cursor and would send the watcher round in circles.
 */
export async function getStartPageToken(): Promise<string> {
  const response = await driveFetch(
    `${DRIVE_CHANGES}/startPageToken?supportsAllDrives=true`
  )
  if (!response.ok) {
    throw new DriveServiceError(`Google Drive failed (${response.status}).`)
  }
  const body = (await response.json()) as { startPageToken?: string }
  if (!body.startPageToken) {
    throw new DriveServiceError("Google Drive returned no change cursor.")
  }
  return body.startPageToken
}

/** The file behind one change. Absent when Google only says a file id is
 * gone, which it does for a file deleted outright rather than trashed. */
export type DriveChangedFile = DriveFile & {
  modifiedTime: string | null
  parents: string[]
  trashed: boolean
}

export type DriveChange = {
  fileId: string
  removed: boolean
  file: DriveChangedFile | null
}

/** Every change since `pageToken`, following the feed to its end. The token
 * to poll with next comes back with them. */
export async function listDriveChanges(
  pageToken: string
): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
  const changes: DriveChange[] = []
  let cursor = pageToken
  for (;;) {
    const page = await changesJson<{
      nextPageToken?: string
      newStartPageToken?: string
      changes?: Array<{
        fileId?: string
        removed?: boolean
        file?: DriveFileResource
      }>
    }>(
      new URLSearchParams({
        pageToken: cursor,
        includeRemoved: "true",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        pageSize: "1000",
        fields: CHANGE_FIELDS,
      })
    )
    for (const change of page.changes ?? []) {
      if (!change.fileId) continue
      changes.push({
        fileId: change.fileId,
        removed: change.removed ?? false,
        file: change.file
          ? {
              ...driveFile(change.file),
              modifiedTime: change.file.modifiedTime ?? null,
              parents: change.file.parents ?? [],
              trashed: change.file.trashed ?? false,
            }
          : null,
      })
    }
    if (page.newStartPageToken) {
      return { changes, newStartPageToken: page.newStartPageToken }
    }
    if (!page.nextPageToken) {
      throw new DriveServiceError("Google Drive returned no change cursor.")
    }
    cursor = page.nextPageToken
  }
}
