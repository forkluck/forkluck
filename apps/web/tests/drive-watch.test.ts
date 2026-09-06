import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const drive = {
  getStartPageToken: vi.fn(),
  listDriveChanges: vi.fn(),
  listDriveFolder: vi.fn(),
  resolveDriveAncestor: vi.fn(),
}
const backend = {
  getDriveWatch: vi.fn(),
  saveDriveWatch: vi.fn(),
  registerDriveFiles: vi.fn(),
}
const readNewDriveFiles = vi.fn()

vi.mock("@/lib/google-drive-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/google-drive-service")
  >("@/lib/google-drive-service")
  return {
    DriveServiceError: actual.DriveServiceError,
    DriveCursorExpiredError: actual.DriveCursorExpiredError,
    getStartPageToken: () => drive.getStartPageToken(),
    listDriveChanges: (token: string) => drive.listDriveChanges(token),
    listDriveFolder: (folderId: string) => drive.listDriveFolder(folderId),
    resolveDriveAncestor: (...args: unknown[]) =>
      drive.resolveDriveAncestor(...args),
  }
})
vi.mock("@/lib/drive-read", () => ({
  readNewDriveFiles: (input: unknown) => readNewDriveFiles(input),
}))
vi.mock("@/lib/backend/queries", () => ({
  getDriveWatch: () => backend.getDriveWatch(),
  saveDriveWatch: (state: unknown) => backend.saveDriveWatch(state),
  registerDriveFiles: (body: unknown) => backend.registerDriveFiles(body),
}))

import {
  planRegistrations,
  runDriveWatch,
  runDriveWatchAndRead,
  startDriveRead,
} from "@/lib/drive-watch"
import {
  DriveCursorExpiredError,
  DriveServiceError,
  type DriveChange,
} from "@/lib/google-drive-service"

const FOLDERS = [
  {
    userId: "user-a",
    folderId: "folder-a",
    folderName: "Receipts",
    registeredAt: "2026-08-01T00:00:00Z",
  },
  {
    userId: "user-b",
    folderId: "folder-b",
    folderName: "Bills",
    registeredAt: "2026-08-01T00:00:00Z",
  },
]

function change(overrides: Partial<DriveChange["file"]> = {}): DriveChange {
  return {
    fileId: "file-1",
    removed: false,
    file: {
      id: "file-1",
      name: "IV101.pdf",
      mimeType: "application/pdf",
      sizeBytes: 120_000,
      modifiedTime: "2026-09-01T10:00:00Z",
      webViewLink: "https://drive.google.com/file/d/file-1/view",
      parents: ["folder-a"],
      trashed: false,
      ...overrides,
    },
  }
}

/** The ancestry the Drive walk would report, keyed by first parent. */
const ancestry: Record<
  string,
  { folderId: string; folderPath: string; excluded: boolean }
> = {
  "folder-a": { folderId: "folder-a", folderPath: "", excluded: false },
  "folder-b": { folderId: "folder-b", folderPath: "", excluded: false },
  september: { folderId: "folder-a", folderPath: "September", excluded: false },
  hidden: { folderId: "folder-a", folderPath: "_working", excluded: true },
}

const resolveAncestor = async (parents: string[]) =>
  ancestry[parents[0]] ?? null

describe("planRegistrations", () => {
  it("registers a changed file to the workspace whose folder holds it", async () => {
    const plan = await planRegistrations({
      changes: [change(), change({ id: "file-2", parents: ["folder-b"] })],
      folders: FOLDERS,
      resolveAncestor,
    })
    expect([...plan.keys()]).toEqual(["user-a", "user-b"])
    expect(plan.get("user-a")).toEqual([
      {
        driveFileId: "file-1",
        name: "IV101.pdf",
        mimeType: "application/pdf",
        sizeBytes: 120_000,
        modifiedTime: "2026-09-01T10:00:00Z",
        webViewLink: "https://drive.google.com/file/d/file-1/view",
        folderPath: "",
        support: "ok",
        removed: false,
      },
    ])
  })

  it("keeps the sub-folder path a file was found under", async () => {
    const plan = await planRegistrations({
      changes: [change({ parents: ["september"] })],
      folders: FOLDERS,
      resolveAncestor,
    })
    expect(plan.get("user-a")?.[0].folderPath).toBe("September")
  })

  it("marks trashed, deleted and moved-away files removed", async () => {
    const plan = await planRegistrations({
      changes: [
        change({ trashed: true }),
        { ...change({ id: "file-2" }), removed: true },
        change({ id: "file-3", parents: ["hidden"] }),
      ],
      folders: FOLDERS,
      resolveAncestor,
    })
    expect(plan.get("user-a")?.map((entry) => entry.removed)).toEqual([
      true,
      true,
      true,
    ])
  })

  it("verdicts a file the extractor cannot read", async () => {
    const plan = await planRegistrations({
      changes: [
        change({ mimeType: "image/heic" }),
        change({
          id: "file-2",
          mimeType: "application/vnd.google-apps.document",
          sizeBytes: null,
        }),
      ],
      folders: FOLDERS,
      resolveAncestor,
    })
    expect(plan.get("user-a")?.map((entry) => entry.support)).toEqual([
      "heic",
      "unsupported",
    ])
  })

  it("offers a change it cannot place to every workspace as removed", async () => {
    const plan = await planRegistrations({
      changes: [
        change({ parents: ["someone-elses-folder"] }),
        { fileId: "file-9", removed: true, file: null },
      ],
      folders: FOLDERS,
      resolveAncestor,
    })
    const workspaces = new Set(FOLDERS.map((folder) => folder.userId))
    expect(new Set(plan.keys())).toEqual(workspaces)
    for (const entries of plan.values()) {
      expect(entries.map((entry) => entry.removed)).toEqual([true, true])
      expect(entries.map((entry) => entry.driveFileId)).toContain("file-9")
    }
  })
})

function watchState(overrides: Record<string, unknown> = {}) {
  return {
    pageToken: "cursor-1",
    polledAt: "2026-09-01T09:00:00Z",
    lastError: "",
    folders: FOLDERS,
    ...overrides,
  }
}

/** What one poll asked Django to write. */
function registered() {
  return backend.registerDriveFiles.mock.calls.map((call) => call[0])
}

function saved() {
  return backend.saveDriveWatch.mock.calls.map((call) => call[0])
}

describe("runDriveWatch", () => {
  beforeEach(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "key"
    backend.getDriveWatch.mockReset()
    backend.saveDriveWatch.mockReset().mockResolvedValue({ ok: true })
    backend.registerDriveFiles.mockReset().mockResolvedValue({
      registered: 1,
      removed: 0,
      newCount: 1,
    })
    drive.getStartPageToken.mockReset().mockResolvedValue("cursor-2")
    drive.listDriveChanges.mockReset()
    drive.listDriveFolder.mockReset().mockResolvedValue([])
    drive.resolveDriveAncestor
      .mockReset()
      .mockImplementation((parents: string[]) => resolveAncestor(parents))
    readNewDriveFiles.mockReset().mockResolvedValue({
      read: 0,
      failed: 0,
      skipped: 0,
    })
  })

  it("lists every unregistered folder and takes a start token on the first run", async () => {
    backend.getDriveWatch.mockResolvedValue(
      watchState({
        pageToken: "",
        folders: FOLDERS.map((folder) => ({ ...folder, registeredAt: null })),
      })
    )
    const result = await runDriveWatch()
    expect(result).toMatchObject({ ok: true, seeded: 2, changes: 0 })
    expect(drive.listDriveChanges).not.toHaveBeenCalled()
    // Both listings mark their folder registered, so the next run trusts the
    // Changes feed for them.
    expect(registered().map((body) => body.markRegistered)).toEqual([
      true,
      true,
    ])
    expect(saved()[0]).toMatchObject({ pageToken: "cursor-2", lastError: "" })
  })

  it("registers a page of changes and advances the cursor", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    drive.listDriveChanges.mockResolvedValue({
      changes: [change()],
      newStartPageToken: "cursor-9",
    })
    const result = await runDriveWatch()
    expect(result).toMatchObject({ ok: true, seeded: 0, changes: 1 })
    expect(drive.listDriveChanges).toHaveBeenCalledWith("cursor-1")
    expect(registered()[0]).toMatchObject({
      userId: "user-a",
      markRegistered: false,
    })
    expect(saved()[0]).toMatchObject({ pageToken: "cursor-9", lastError: "" })
  })

  it("re-lists every folder when Google has dropped the cursor", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    drive.listDriveChanges.mockRejectedValue(
      new DriveCursorExpiredError("gone")
    )
    const result = await runDriveWatch()
    expect(result).toMatchObject({ ok: true, seeded: 2 })
    expect(drive.listDriveFolder).toHaveBeenCalledTimes(2)
    expect(saved()[0]).toMatchObject({ pageToken: "cursor-2", lastError: "" })
  })

  it("records the failure and keeps the cursor where it was", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    drive.listDriveChanges.mockRejectedValue(
      new DriveServiceError("Google Drive failed (503).")
    )
    const result = await runDriveWatch()
    expect(result).toMatchObject({
      ok: false,
      error: "Google Drive failed (503).",
    })
    expect(saved()[0]).toMatchObject({
      pageToken: "cursor-1",
      lastError: "Google Drive failed (503).",
    })
  })

  it("hands a second caller the run already in flight", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    drive.listDriveChanges.mockResolvedValue({
      changes: [],
      newStartPageToken: "cursor-9",
    })
    const [first, second] = await Promise.all([
      runDriveWatch(),
      runDriveWatch(),
    ])
    expect(first).toBe(second)
    expect(backend.getDriveWatch).toHaveBeenCalledTimes(1)
  })

  it("reads what it registered on the timer's run, and not on a bare poll", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    drive.listDriveChanges.mockResolvedValue({
      changes: [],
      newStartPageToken: "cursor-9",
    })

    await runDriveWatch()
    expect(readNewDriveFiles).not.toHaveBeenCalled()

    await runDriveWatchAndRead()
    expect(readNewDriveFiles).toHaveBeenCalledWith({ folders: FOLDERS })
  })

  it("keeps one reader at a time, on its own guard", async () => {
    backend.getDriveWatch.mockResolvedValue(watchState())
    let release = () => {}
    readNewDriveFiles.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({})))
    )

    const first = startDriveRead()
    const second = startDriveRead()
    expect(first).toBe(second)

    // The poll's guard is a different one: a running read never blocks the
    // next registration.
    drive.listDriveChanges.mockResolvedValue({
      changes: [],
      newStartPageToken: "cursor-9",
    })
    expect(await runDriveWatch()).toMatchObject({ ok: true })
    expect(readNewDriveFiles).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it("does nothing at all without a service account", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    expect(await runDriveWatch()).toEqual({
      ok: true,
      seeded: 0,
      changes: 0,
      registered: 0,
    })
    expect(backend.getDriveWatch).not.toHaveBeenCalled()
  })
})
