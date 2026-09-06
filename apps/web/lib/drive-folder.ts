/**
 * The Drive folder source, in the rules both sides of the wire need: the
 * server that lists the folder and the browser that renders the candidates.
 * Nothing here touches Google — `lib/google-drive-service.ts` owns the
 * credential and the HTTP.
 */

/** What the extractor can be handed. Photos reach the AI path, not the
 * template. */
export const DRIVE_SUPPORTED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const

/** Raw bytes per file, by kind: a PDF stays under the request body cap, a
 * photo under Anthropic's 10 MB once base64 has grown it by a third. */
export const DRIVE_MAX_PDF_BYTES = 5_500_000
export const DRIVE_MAX_IMAGE_BYTES = 7_000_000

export type DriveFile = {
  id: string
  name: string
  mimeType: string
  /** Drive omits the size of a Google-native document. */
  sizeBytes: number | null
  webViewLink: string
}

export type DriveFileSupport = "ok" | "heic" | "unsupported" | "too_large"

/**
 * The folder id out of whatever the user pasted: a folder link, an `open?id=`
 * link, or the bare id. Returns null when it is neither.
 */
export function parseDriveFolderId(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  const folder = value.match(/\/folders\/([A-Za-z0-9_-]+)/)
  if (folder) return folder[1]
  const query = value.match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (query) return query[1]
  // A bare id only: the character class excludes every URL separator.
  return /^[A-Za-z0-9_-]{10,128}$/.test(value) ? value : null
}

/**
 * Whether this file can be imported. HEIC is called out separately because
 * the fix is on the phone, not in Forkluck.
 */
export function driveFileSupport(file: DriveFile): DriveFileSupport {
  const name = file.name.toLowerCase()
  if (
    file.mimeType === "image/heic" ||
    file.mimeType === "image/heif" ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  ) {
    return "heic"
  }
  if (!(DRIVE_SUPPORTED_MIME as readonly string[]).includes(file.mimeType)) {
    return "unsupported"
  }
  const max =
    file.mimeType === "application/pdf"
      ? DRIVE_MAX_PDF_BYTES
      : DRIVE_MAX_IMAGE_BYTES
  if (file.sizeBytes !== null && file.sizeBytes > max) return "too_large"
  return "ok"
}
