import "server-only"

import {
  getDriveWatch,
  registerDriveFiles,
  saveDriveWatch,
} from "@/lib/backend/queries"
import type { DriveWatchFolder } from "@/lib/backend/types"
import { driveFileSupport, type DriveFileSupport } from "@/lib/drive-folder"
import { readNewDriveFiles } from "@/lib/drive-read"
import {
  DriveCursorExpiredError,
  DriveServiceError,
  getStartPageToken,
  listDriveChanges,
  listDriveFolder,
  resolveDriveAncestor,
  type DriveAncestor,
  type DriveAncestorCache,
  type DriveChange,
} from "@/lib/google-drive-service"

/**
 * One poll of the Google Drive Changes feed for the whole installation.
 *
 * The service account holds a single cursor over every folder shared with it,
 * so this runs once — on a timer in `instrumentation.ts`, or when a merchant
 * presses "Check now" — and sorts each changed file to the workspace whose
 * connected folder is its ancestor. Django keeps the registry and the cursor;
 * every byte of Google I/O happens here.
 */

/** One entry of `POST system/drive-files/`. Django caps the text columns, so
 * a pathological name or a deep nest is trimmed rather than failing the batch
 * it travels in. */
export type DriveRegistration = {
  driveFileId: string
  name: string
  mimeType: string
  sizeBytes: number | null
  modifiedTime: string | null
  webViewLink: string
  folderPath: string
  support: DriveFileSupport
  removed: boolean
}

/** Django's per-call limit. */
const CHUNK = 500

function trim(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Which workspaces a page of changes touches, and what to register to each.
 *
 * A file that has been trashed, deleted, or moved into a `_` working folder
 * registers as removed, which is how a row leaves the registry. A change the
 * feed cannot place — deleted outright (no file resource comes back), or
 * moved out of every connected folder — is offered to every workspace as
 * removed: Django drops the row where one exists and ignores it elsewhere,
 * so no registry keeps offering a receipt that is gone.
 */
export async function planRegistrations({
  changes,
  folders,
  resolveAncestor,
}: {
  changes: DriveChange[]
  folders: DriveWatchFolder[]
  resolveAncestor: (parents: string[]) => Promise<DriveAncestor | null>
}): Promise<Map<string, DriveRegistration[]>> {
  // Two workspaces may share one folder, so a folder id names a list.
  const owners = new Map<string, string[]>()
  for (const folder of folders) {
    const existing = owners.get(folder.folderId)
    if (existing) existing.push(folder.userId)
    else owners.set(folder.folderId, [folder.userId])
  }

  const everyone = [...new Set(folders.map((folder) => folder.userId))]
  const plan = new Map<string, DriveRegistration[]>()
  const add = (userId: string, entry: DriveRegistration) => {
    const list = plan.get(userId)
    if (list) list.push(entry)
    else plan.set(userId, [entry])
  }
  for (const change of changes) {
    const file = change.file
    const ancestor = file ? await resolveAncestor(file.parents) : null
    if (!file || !ancestor) {
      const gone: DriveRegistration = {
        driveFileId: change.fileId,
        name: file ? trim(file.name, 255) : "",
        mimeType: "",
        sizeBytes: null,
        modifiedTime: null,
        webViewLink: "",
        folderPath: "",
        support: "unsupported",
        removed: true,
      }
      for (const userId of everyone) add(userId, gone)
      continue
    }
    const entry: DriveRegistration = {
      driveFileId: file.id,
      name: trim(file.name, 255),
      mimeType: trim(file.mimeType, 128),
      sizeBytes: file.sizeBytes,
      modifiedTime: file.modifiedTime,
      webViewLink: trim(file.webViewLink, 500),
      folderPath: trim(ancestor.folderPath, 255),
      support: driveFileSupport(file),
      removed: change.removed || file.trashed || ancestor.excluded,
    }
    for (const userId of owners.get(ancestor.folderId) ?? []) add(userId, entry)
  }
  return plan
}

export type DriveWatchResult = {
  ok: boolean
  /** Folders listed in full this run. */
  seeded: number
  changes: number
  registered: number
  error?: string
}

async function registerFiles(
  userId: string,
  files: DriveRegistration[],
  markRegistered: boolean
): Promise<number> {
  let registered = 0
  // An empty listing still has to mark the folder registered, so the loop
  // always makes at least one call.
  for (let start = 0; start < files.length || start === 0; start += CHUNK) {
    const chunk = files.slice(start, start + CHUNK)
    const last = start + CHUNK >= files.length
    const result = await registerDriveFiles({
      userId,
      files: chunk,
      markRegistered: markRegistered && last,
    })
    registered += result.registered
  }
  return registered
}

/** The whole folder, for a folder the watcher has never listed — the files
 * already sitting in it are older than any cursor. */
async function seedFolder(folder: DriveWatchFolder): Promise<number> {
  const files = await listDriveFolder(folder.folderId)
  return registerFiles(
    folder.userId,
    files.map((file) => ({
      driveFileId: file.id,
      name: trim(file.name, 255),
      mimeType: trim(file.mimeType, 128),
      sizeBytes: file.sizeBytes,
      modifiedTime: file.modifiedTime,
      webViewLink: trim(file.webViewLink, 500),
      folderPath: trim(file.folderPath, 255),
      support: driveFileSupport(file),
      removed: false,
    })),
    true
  )
}

function watchError(cause: unknown): string {
  if (cause instanceof DriveServiceError) return cause.message
  return cause instanceof Error
    ? trim(cause.message, 200)
    : "Drive check failed."
}

let inFlight: Promise<DriveWatchResult> | null = null
let reading: Promise<void> | null = null

/**
 * Poll once. Never throws: a failed run records its message on the shared
 * watch state, which is what the folder card and the invoices line show.
 */
export function runDriveWatch(): Promise<DriveWatchResult> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return Promise.resolve({ ok: true, seeded: 0, changes: 0, registered: 0 })
  }
  // "Check now" and the timer share whatever run is already going: two polls
  // of one cursor would race each other into a lost page of changes.
  if (inFlight) return inFlight
  const run = poll().finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

/**
 * Read the files the registry is holding. Guarded on its own rather than with
 * the poll: a read runs the AI over several documents and takes minutes, and
 * it must never hold up the next registration.
 */
export function startDriveRead(): Promise<void> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return Promise.resolve()
  if (reading) return reading
  const run = read().finally(() => {
    reading = null
  })
  reading = run
  return run
}

async function read(): Promise<void> {
  try {
    // Re-read rather than reuse the poll's state: the poll may have just
    // seeded a folder, which is what makes it readable.
    const state = await getDriveWatch()
    await readNewDriveFiles({ folders: state.folders })
  } catch (cause) {
    console.info(`Drive read failed: ${watchError(cause)}`)
  }
}

/** The timer's run: register what changed, then read what is new. */
export async function runDriveWatchAndRead(): Promise<DriveWatchResult> {
  const result = await runDriveWatch()
  if (result.ok) await startDriveRead()
  return result
}

async function poll(): Promise<DriveWatchResult> {
  const polledAt = new Date().toISOString()
  let seeded = 0
  let changes = 0
  let registered = 0
  // Distinct workspaces this run wrote to, for the summary line.
  const touched = new Set<string>()
  let state
  try {
    state = await getDriveWatch()
  } catch (cause) {
    const error = watchError(cause)
    console.info(`Drive watch failed before it started: ${error}`)
    return { ok: false, seeded, changes, registered, error }
  }

  try {
    const pending = state.folders.filter(
      (folder) => folder.registeredAt === null
    )
    for (const folder of pending) {
      registered += await seedFolder(folder)
      touched.add(folder.userId)
      seeded += 1
    }

    if (!state.pageToken) {
      // The listings above are the present state; the cursor covers what
      // happens from here.
      await saveDriveWatch({
        pageToken: await getStartPageToken(),
        polledAt,
        lastError: "",
      })
    } else {
      let page
      try {
        page = await listDriveChanges(state.pageToken)
      } catch (cause) {
        if (!(cause instanceof DriveCursorExpiredError)) throw cause
        // Google forgot the cursor. A fresh one only covers the future, so
        // every folder is listed again to catch what happened meanwhile.
        const pageToken = await getStartPageToken()
        for (const folder of state.folders) {
          if (folder.registeredAt === null) continue
          registered += await seedFolder(folder)
          touched.add(folder.userId)
          seeded += 1
        }
        await saveDriveWatch({ pageToken, polledAt, lastError: "" })
        console.info(
          `Drive watch re-seeded ${seeded} folders after an expired cursor, ${registered} files registered`
        )
        return { ok: true, seeded, changes, registered }
      }
      changes = page.changes.length
      const cache: DriveAncestorCache = new Map()
      const folderIds = new Set(state.folders.map((folder) => folder.folderId))
      const plan = await planRegistrations({
        changes: page.changes,
        folders: state.folders,
        resolveAncestor: (parents) =>
          resolveDriveAncestor(parents, folderIds, cache),
      })
      for (const [userId, files] of plan) {
        registered += await registerFiles(userId, files, false)
        touched.add(userId)
      }
      await saveDriveWatch({
        pageToken: page.newStartPageToken,
        polledAt,
        lastError: "",
      })
    }
  } catch (cause) {
    const error = watchError(cause)
    // The cursor is left where it was, so the next run reads the same page
    // again rather than skipping it.
    try {
      await saveDriveWatch({
        pageToken: state.pageToken,
        polledAt,
        lastError: error,
      })
    } catch {
      // Django is unreachable; the next run reports it again.
    }
    console.info(`Drive watch failed after ${changes} changes: ${error}`)
    return { ok: false, seeded, changes, registered, error }
  }

  console.info(
    `Drive watch: ${seeded} folders seeded, ${changes} changes, ${registered} files registered across ${touched.size} workspaces`
  )
  return { ok: true, seeded, changes, registered }
}
