import { NextResponse } from "next/server"

import { getSession } from "@/lib/auth-session"
import { getDriveFolder } from "@/lib/backend/queries"
import { DRIVE_MAX_IMAGE_BYTES, DRIVE_MAX_PDF_BYTES } from "@/lib/drive-folder"
import {
  DriveServiceError,
  assertFileInFolder,
  fetchDriveFileBytes,
} from "@/lib/google-drive-service"

/**
 * The bytes of one file in the connected Drive folder, so the import dialog
 * can show the document beside the lines it read. A file picked or uploaded
 * in the browser never comes through here — the browser already holds those
 * bytes and shows them from an object URL.
 *
 * Same guards as the parse route (same-origin, session, entitlement), plus
 * the folder check: the service account reads every folder shared with it,
 * so the id in the query string is not authorization.
 */
export async function GET(request: Request) {
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

  const fileId = new URL(request.url).searchParams.get("id")?.trim()
  if (!fileId || fileId.length > 128) {
    return NextResponse.json(
      { error: "That file couldn't be read." },
      {
        status: 400,
      }
    )
  }

  try {
    const { folder } = await getDriveFolder()
    if (!folder) {
      return NextResponse.json(
        { error: "No Drive folder is connected." },
        { status: 404 }
      )
    }
    await assertFileInFolder(fileId, folder.folderId)
    const fetched = await fetchDriveFileBytes(fileId, (mimeType) =>
      mimeType === "application/pdf"
        ? DRIVE_MAX_PDF_BYTES
        : DRIVE_MAX_IMAGE_BYTES
    )
    return new NextResponse(Buffer.from(fetched.base64, "base64"), {
      headers: {
        "Content-Type": fetched.mimeType || "application/octet-stream",
        "Content-Length": String(fetched.bytes),
        "Content-Disposition": "inline",
        // One workspace's supplier document: never a shared or stored copy.
        "Cache-Control": "private, no-store",
      },
    })
  } catch (cause) {
    return NextResponse.json(
      {
        error:
          cause instanceof DriveServiceError
            ? cause.message
            : "Couldn't read that file from Google Drive.",
      },
      { status: 404 }
    )
  }
}
