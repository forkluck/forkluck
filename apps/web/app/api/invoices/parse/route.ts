import { NextResponse } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth-session"
import { DRIVE_MAX_PDF_BYTES } from "@/lib/drive-folder"
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/import-limits"
import { runInvoiceParse } from "@/lib/invoice-parse"

/** Base64 grows bytes by a third. A photo is allowed to be larger than a PDF:
 * it is one page, photographed. */
const base64Cap = (bytes: number) => Math.ceil(bytes / 3) * 4

/**
 * Two ways in, and only one of them carries bytes. A file picked from the
 * connected Drive folder is named, never uploaded: the server fetches it, and
 * takes its MIME and size from Drive rather than from this body, so a client
 * cannot describe a file into a shape the pipeline would trust.
 */
const uploadedInputSchema = z
  .object({
    base64: z.string().min(1).max(base64Cap(MAX_IMAGE_UPLOAD_BYTES)),
    mediaType: z
      .enum(["application/pdf", "image/jpeg", "image/png", "image/webp"])
      .default("application/pdf"),
    fileName: z.string().trim().min(1).max(255),
    driveFileId: z.string().trim().min(1).max(128).nullable(),
    driveWebViewLink: z.string().trim().url().max(500).nullable(),
  })
  .refine(
    (input) =>
      input.mediaType !== "application/pdf" ||
      input.base64.length <= base64Cap(DRIVE_MAX_PDF_BYTES),
    { path: ["base64"] }
  )

const driveInputSchema = z.object({
  // Bytes here would mean the upload arm refused this body; a refused upload
  // must not fall through into a Drive fetch.
  base64: z.undefined().optional(),
  driveFileId: z.string().trim().min(1).max(128),
  fileName: z.string().trim().min(1).max(255),
  driveWebViewLink: z.string().trim().url().max(500).nullable(),
})

const parseInputSchema = z.union([uploadedInputSchema, driveInputSchema])

/**
 * Parses one invoice file. A route handler instead of a server action so the
 * import dialog can keep a few files in flight at once — Next serializes
 * server actions per client, which would turn a 25-invoice month into a
 * one-at-a-time crawl.
 */
export async function POST(request: Request) {
  // Same-origin guard: the AI call costs real money per request.
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (origin && host) {
    let originHost: string | null
    try {
      originHost = new URL(origin).host
    } catch {
      // "Origin: null" (sandboxed iframe, opaque redirect) or garbage.
      originHost = null
    }
    if (originHost !== host) {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 })
    }
  }

  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    )
  }
  if (!session.billing.entitlements.invoiceAi) {
    return NextResponse.json(
      { error: "Invoice reading isn't included on your plan." },
      { status: 403 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }
  const parsed = parseInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That file couldn't be read." },
      { status: 400 }
    )
  }

  const input = parsed.data
  const encoder = new TextEncoder()
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Leading whitespace is valid JSON. Send it now and while the model is
      // working so nginx's 120s idle timeout cannot discard a completed read.
      // Existing clients can still consume the final body with response.json().
      const send = (text: string) => {
        if (!cancelled) controller.enqueue(encoder.encode(text))
      }
      send("\n")
      heartbeat = setInterval(() => send("\n"), 15_000)
      void runInvoiceParse(
        input.base64 !== undefined
          ? {
              file:
                input.mediaType === "application/pdf"
                  ? {
                      kind: "pdf" as const,
                      mediaType: input.mediaType,
                      base64: input.base64,
                    }
                  : {
                      kind: "image" as const,
                      mediaType: input.mediaType,
                      base64: input.base64,
                    },
              fileName: input.fileName,
              driveFileId: input.driveFileId,
              driveWebViewLink: input.driveWebViewLink,
            }
          : {
              file: null,
              fileName: input.fileName,
              driveFileId: input.driveFileId,
              driveWebViewLink: input.driveWebViewLink,
            }
      )
        .then((result) => send(JSON.stringify(result)))
        .catch(() =>
          send(
            JSON.stringify({
              error: "Couldn't read that file. Please try again.",
            })
          )
        )
        .finally(() => {
          clearInterval(heartbeat)
          if (!cancelled) controller.close()
        })
    },
    cancel() {
      cancelled = true
      clearInterval(heartbeat)
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  })
}
