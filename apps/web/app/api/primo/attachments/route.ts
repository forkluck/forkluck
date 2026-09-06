import { getSession } from "@/lib/auth-session"
import { djangoAction } from "@/lib/backend/client"
import { getDocument, putDocument, deleteDocument } from "@/lib/document-store"
import { primoAvailable } from "@/lib/primo/access"
import {
  attachmentType,
  attachmentLimit,
  ATTACHMENT_PROCESSING_MS,
} from "@/lib/primo/attachments"
import {
  cleanupPrimoAttachments,
  extractAttachment,
  readPrimoAttachment,
} from "@/lib/primo/attachment-server"
import { sameOrigin } from "@/lib/primo/origin"
import { z } from "zod"
export const maxDuration = 300

async function guard(request: Request, write = true) {
  if (write && !sameOrigin(request))
    return Response.json({ error: "Not allowed." }, { status: 403 })
  const session = await getSession()
  if (!session)
    return Response.json({ error: "Sign in to use Primo." }, { status: 401 })
  if (!primoAvailable(session.billing))
    return Response.json({ error: "Primo is unavailable." }, { status: 403 })
  return session
}
export async function POST(request: Request) {
  const session = await guard(request)
  if (session instanceof Response) return session
  let name: string
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "").slice(
      0,
      255
    )
  } catch {
    return Response.json({ error: "Invalid filename." }, { status: 400 })
  }
  const conversationId = request.headers.get("x-conversation-id")
  const mediaType = attachmentType(name)
  if (!z.uuid().safeParse(conversationId).success || !mediaType)
    return Response.json(
      { error: "Choose an image, PDF, text, CSV, XLSX or DOCX file." },
      { status: 400 }
    )
  const cap = attachmentLimit(mediaType)
  let key: string | undefined
  let attachmentId: string | undefined
  const cancelled = new AbortController()
  const signal = AbortSignal.any([request.signal, cancelled.signal])
  const timeout = setTimeout(
    () => cancelled.abort(new Error("Reading took too long. Try again.")),
    ATTACHMENT_PROCESSING_MS
  )
  let discarding: Promise<void> | undefined
  const discard = () =>
    (discarding ??= (async () => {
      if (attachmentId)
        await djangoAction("primo-attachment", {
          operation: "remove",
          id: attachmentId,
        }).catch(() => {})
      if (key) await deleteDocument(key).catch(() => {})
    })())
  const errorMessage = (cause: unknown) =>
    signal.aborted
      ? "Reading was interrupted or took too long. Try again."
      : cause instanceof Error &&
          /^(That file|No readable|Choose|Too many files|That PDF|Page \d)/.test(
            cause.message
          )
        ? cause.message
        : "Couldn’t read that file. Check its format and try again."
  try {
    const reader = request.body?.getReader()
    if (!reader) throw new Error("That file is empty.")
    const cancelBody = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener("abort", cancelBody, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > cap) {
          await reader.cancel()
          throw new Error("That file is too large.")
        }
        chunks.push(value)
      }
    } finally {
      signal.removeEventListener("abort", cancelBody)
    }
    signal.throwIfAborted()
    if (!size) throw new Error("That file is empty.")
    const bytes = Buffer.concat(chunks)
    key = await putDocument({
      userId: session.user.id,
      bytes,
      contentType: mediaType,
      fileName: name,
    })
    signal.throwIfAborted()
    const reserved = await djangoAction<{ item: { id: string } }>(
      "primo-attachment",
      { operation: "create", conversationId, key, name, mediaType, size }
    )
    attachmentId = reserved.item.id
    signal.throwIfAborted()
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat: ReturnType<typeof setInterval>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text))
        }
        // Whitespace keeps JSON clients compatible and nginx's idle timer alive.
        send("\n")
        heartbeat = setInterval(() => send("\n"), 15_000)
        void (async () => {
          let abortRead: () => void = () => {}
          let failed = false
          try {
            const extracted = await Promise.race([
              extractAttachment(bytes, mediaType, signal),
              new Promise<never>((_, reject) => {
                abortRead = () => reject(signal.reason)
                if (signal.aborted) abortRead()
                else signal.addEventListener("abort", abortRead, { once: true })
              }),
            ])
            signal.throwIfAborted()
            const result = await djangoAction("primo-attachment", {
              operation: "finish",
              id: attachmentId,
              ...extracted,
            })
            signal.throwIfAborted()
            send(JSON.stringify(result))
          } catch (cause) {
            failed = true
            send(JSON.stringify({ error: errorMessage(cause) }))
          } finally {
            signal.removeEventListener("abort", abortRead)
            clearInterval(heartbeat)
            clearTimeout(timeout)
            if (!closed) {
              closed = true
              controller.close()
            }
          }
          // A slow cleanup service must not keep the retryable error response open.
          if (failed) await discard()
          await cleanupPrimoAttachments().catch(() => {})
        })()
      },
      async cancel() {
        closed = true
        cancelled.abort()
        clearInterval(heartbeat)
        clearTimeout(timeout)
        await discard()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (cause) {
    clearTimeout(timeout)
    await discard()
    return Response.json({ error: errorMessage(cause) }, { status: 400 })
  }
}

export async function GET(request: Request) {
  const session = await guard(request, false)
  if (session instanceof Response) return session
  const params = new URL(request.url).searchParams
  try {
    const item = await readPrimoAttachment(
      params.get("id") ?? "",
      params.get("conversationId") ?? ""
    )
    if (params.get("preview") === "text")
      return Response.json(
        { content: item.content },
        { headers: { "Cache-Control": "private, no-store" } }
      )
    const file = await getDocument(item.key)
    if (!file) throw new Error("Missing file")
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": item.mediaType,
        "Content-Disposition": `${params.get("preview") === "media" && item.mediaType.startsWith("image/") ? "inline" : "attachment"}; filename="${item.name.replace(/[^\w. -]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return Response.json({ error: "File not found." }, { status: 404 })
  }
}
export async function DELETE(request: Request) {
  const session = await guard(request)
  if (session instanceof Response) return session
  try {
    await djangoAction("primo-attachment", {
      operation: "remove",
      id: new URL(request.url).searchParams.get("id"),
    })
    await cleanupPrimoAttachments()
    return Response.json({ ok: true })
  } catch {
    return Response.json(
      { error: "Couldn’t remove that file." },
      { status: 400 }
    )
  }
}
