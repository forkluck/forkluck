"use client"
import * as React from "react"
import {
  attachmentSchema,
  attachmentType,
  attachmentLimit,
  ATTACHMENT_COUNT_LIMIT,
  ATTACHMENT_TOTAL_BYTES,
  ATTACHMENT_PROCESSING_MS,
  type PrimoAttachment,
} from "@/lib/primo/attachments"
import { primoMentionSchema, type PrimoMention } from "@/lib/primo/messages"

export type DraftFile = {
  id: string
  name: string
  size: number
  status: "uploading" | "reading" | "ready" | "error" | "removing"
  item?: PrimoAttachment
  file?: File
  error?: string
}
export type PrimoDraft = {
  text: string
  mentions: PrimoMention[]
  files: DraftFile[]
  fileErrors?: string[]
}
const EMPTY: PrimoDraft = { text: "", mentions: [], files: [] }
export function createPrimoDraftStore(scope: string) {
  const values = new Map<string, PrimoDraft>()
  const listeners = new Set<() => void>()
  const requests = new Map<string, AbortController>()
  const key = (id: string) => `primo:draft-v2:${scope}:${id}`
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get(id: string) {
      if (!values.has(id)) {
        let value = EMPTY
        try {
          const saved = JSON.parse(localStorage.getItem(key(id)) ?? "null")
          if (saved && typeof saved.text === "string")
            value = {
              text: saved.text.slice(0, 4000),
              mentions: (saved.mentions ?? [])
                .filter((m: unknown) => primoMentionSchema.safeParse(m).success)
                .slice(0, 10),
              files: (saved.files ?? []).slice(0, 5).map((f: DraftFile) =>
                f.status === "ready" &&
                attachmentSchema.safeParse(f.item).success
                  ? f
                  : {
                      ...f,
                      status: "error",
                      error: "Attach this file again to continue.",
                    }
              ),
            }
        } catch {}
        values.set(id, value)
      }
      return values.get(id)!
    },
    set(id: string, update: (draft: PrimoDraft) => PrimoDraft) {
      const next = update(this.get(id))
      values.set(id, next)
      try {
        if (!next.text && !next.files.length) localStorage.removeItem(key(id))
        else
          localStorage.setItem(
            key(id),
            JSON.stringify({
              ...next,
              files: next.files.map((file) => ({
                id: file.id,
                name: file.name,
                size: file.size,
                status: file.status,
                item: file.item,
                error: file.error,
              })),
            })
          )
      } catch {}
      listeners.forEach((listener) => listener())
    },
    addFiles(id: string, files: File[]) {
      const accepted: DraftFile[] = []
      const errors: string[] = []
      // Reserve the whole batch synchronously against the latest store value.
      // Two drops in the same render must not each see five free slots.
      store.set(id, (draft) => {
        let total = draft.files.reduce((sum, file) => sum + file.size, 0)
        for (const file of files) {
          const type = attachmentType(file.name)
          const problem = !type
            ? "Choose a PDF, image, DOCX, TXT, CSV or XLSX file."
            : !file.size
              ? "This file is empty."
              : file.size > attachmentLimit(type)
                ? `The limit is ${attachmentLimit(type) / 1_000_000} MB per file.`
                : draft.files.length + accepted.length >= ATTACHMENT_COUNT_LIMIT
                  ? "Attach up to five files per message."
                  : total + file.size > ATTACHMENT_TOTAL_BYTES
                    ? "Attachments must be 20 MB or less combined."
                    : ""
          if (problem) {
            errors.push(`“${file.name}”: ${problem}`)
            continue
          }
          total += file.size
          accepted.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            status: "uploading",
            file,
          })
        }
        return {
          ...draft,
          files: [...draft.files, ...accepted],
          fileErrors: [...(draft.fileErrors ?? []), ...errors],
        }
      })
      for (const file of accepted) void store.upload(id, file.id)
    },
    async upload(id: string, fileId: string) {
      const entry = store.get(id).files.find((file) => file.id === fileId)
      if (!entry?.file || requests.has(fileId)) return
      const controller = new AbortController()
      requests.set(fileId, controller)
      const current = () => requests.get(fileId) === controller
      const update = (patch: Partial<DraftFile>) => {
        if (current())
          store.set(id, (draft) => ({
            ...draft,
            files: draft.files.map((file) =>
              file.id === fileId ? { ...file, ...patch } : file
            ),
          }))
      }
      update({ status: "uploading", error: undefined })
      const timeout = window.setTimeout(
        () => controller.abort(),
        ATTACHMENT_PROCESSING_MS + 30_000
      )
      try {
        const response = await fetch("/api/primo/attachments", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(entry.name),
            "x-conversation-id": id,
          },
          body: entry.file,
          signal: controller.signal,
        })
        if (response.ok) update({ status: "reading" })
        const result = await response.json().catch(() => {
          throw new Error("Upload was interrupted. Try again.")
        })
        // Processing errors can arrive after the JSON keep-alive began (HTTP 200).
        if (!response.ok || result.error)
          throw new Error(result.error || "Upload failed. Try again.")
        const parsed = attachmentSchema.safeParse(result.item)
        if (!parsed.success)
          throw new Error("Upload was interrupted. Try again.")
        const item = parsed.data
        controller.signal.throwIfAborted()
        if (current()) update({ status: "ready", item, file: undefined })
      } catch (error) {
        update({
          status: "error",
          error: controller.signal.aborted
            ? "Reading took too long. Try again."
            : error instanceof Error
              ? error.message
              : "Upload failed. Try again.",
        })
      } finally {
        window.clearTimeout(timeout)
        if (current()) requests.delete(fileId)
      }
    },
    async removeFile(id: string, fileId: string) {
      const entry = store.get(id).files.find((file) => file.id === fileId)
      if (!entry || entry.status === "removing") return
      requests.get(fileId)?.abort()
      requests.delete(fileId)
      if (entry.item) {
        const controller = new AbortController()
        requests.set(fileId, controller)
        store.set(id, (draft) => ({
          ...draft,
          files: draft.files.map((file) =>
            file.id === fileId
              ? { ...file, status: "removing", error: undefined }
              : file
          ),
        }))
        try {
          const response = await fetch(
            `/api/primo/attachments?id=${entry.item.id}`,
            {
              method: "DELETE",
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(30_000),
              ]),
            }
          )
          if (requests.get(fileId) !== controller) return
          if (!response.ok) throw new Error("Remove failed")
        } catch {
          if (requests.get(fileId) === controller)
            store.set(id, (draft) => ({
              ...draft,
              files: draft.files.map((file) =>
                file.id === fileId
                  ? { ...entry, error: "Couldn’t remove this file. Try again." }
                  : file
              ),
            }))
          return
        } finally {
          if (requests.get(fileId) === controller) requests.delete(fileId)
        }
      }
      store.set(id, (draft) => ({
        ...draft,
        files: draft.files.filter((file) => file.id !== fileId),
      }))
    },
    dispose() {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
    },
  }
  return store
}
const DraftContext = React.createContext<ReturnType<
  typeof createPrimoDraftStore
> | null>(null)
export function PrimoDraftProvider({
  children,
  userId,
}: {
  children: React.ReactNode
  userId: string
}) {
  const [store] = React.useState(() => createPrimoDraftStore(userId))
  React.useEffect(() => () => store.dispose(), [store])
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>
}
export function usePrimoDraft(id: string) {
  const context = React.useContext(DraftContext)
  const [fallback] = React.useState(() => createPrimoDraftStore("local"))
  React.useEffect(() => () => fallback.dispose(), [fallback])
  const store = context ?? fallback
  const draft = React.useSyncExternalStore(
    store.subscribe,
    () => store.get(id),
    () => EMPTY
  )
  const setDraft = React.useCallback(
    (update: (draft: PrimoDraft) => PrimoDraft) => store.set(id, update),
    [id, store]
  )
  const files = React.useMemo(
    () => ({
      add: (files: File[]) => store.addFiles(id, files),
      retry: (fileId: string) => store.upload(id, fileId),
      remove: (fileId: string) => store.removeFile(id, fileId),
    }),
    [id, store]
  )
  return [draft, setDraft, files] as const
}
