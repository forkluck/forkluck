import { NextResponse } from "next/server"

import { getSession } from "@/lib/auth-session"
import {
  DOCUMENT_MAX_IMAGE_BYTES,
  DOCUMENT_MAX_PDF_BYTES,
  getDocument,
  isDocumentKey,
  isDocumentKeyOf,
  putDocument,
} from "@/lib/document-store"

/**
 * The uploaded invoice document: POST keeps the merchant's own file at import
 * time, GET hands it back to the invoice page. A Drive-folder file never comes
 * through here — it stays in the folder and is read by id.
 *
 * Same guards as the Drive route (same-origin, session, entitlement), plus the
 * key check: a key names one user's file, so it is checked against the session
 * rather than trusted from the query string.
 */

const CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
])

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (!origin || !host) return true
  try {
    return new URL(origin).host === host
  } catch {
    // "Origin: null" (sandboxed iframe, opaque redirect) or garbage.
    return false
  }
}

/** The guards, or the response that refuses. Answers the user id on success:
 *  a NextResponse is the refusal, so a caller cannot forget to return it. */
async function guard(request: Request): Promise<NextResponse | string> {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 })
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
  return session.user.id
}

export async function POST(request: Request) {
  const userId = await guard(request)
  if (typeof userId !== "string") return userId

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
  if (!CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: "That file type can't be kept." },
      { status: 400 }
    )
  }
  const bytes = Buffer.from(await request.arrayBuffer())
  const cap =
    contentType === "application/pdf"
      ? DOCUMENT_MAX_PDF_BYTES
      : DOCUMENT_MAX_IMAGE_BYTES
  if (bytes.length === 0 || bytes.length > cap) {
    return NextResponse.json(
      { error: "That file is too big." },
      { status: 400 }
    )
  }

  const key = await putDocument({
    userId,
    bytes,
    contentType,
    fileName: request.headers.get("x-file-name")?.slice(0, 255) || "document",
  })
  return NextResponse.json({ key })
}

export async function GET(request: Request) {
  const userId = await guard(request)
  if (typeof userId !== "string") return userId

  const key = new URL(request.url).searchParams.get("key")?.trim() ?? ""
  if (!isDocumentKey(key)) {
    return NextResponse.json(
      { error: "That file couldn't be read." },
      { status: 400 }
    )
  }
  if (!isDocumentKeyOf(key, userId)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  }
  const document = await getDocument(key)
  if (!document) {
    return NextResponse.json(
      { error: "That file couldn't be read." },
      { status: 404 }
    )
  }
  return new NextResponse(new Uint8Array(document.bytes), {
    headers: {
      "Content-Type": document.contentType,
      "Content-Length": String(document.bytes.length),
      "Content-Disposition": "inline",
      // One workspace's supplier document: never a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  })
}
