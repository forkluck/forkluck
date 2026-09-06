import { z } from "zod"

export const ATTACHMENT_COUNT_LIMIT = 5
export const ATTACHMENT_TOTAL_BYTES = 20_000_000
export const ATTACHMENT_TEXT_LIMIT = 24_000
export const ATTACHMENT_PROCESSING_MS = 240_000

export const attachmentSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().max(255),
  mediaType: z.string().max(100),
  size: z.number().int().positive().max(8_000_000),
  coverage: z.string().max(255),
})
export type PrimoAttachment = z.infer<typeof attachmentSchema>
export const ATTACHMENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",")
export function attachmentType(name: string) {
  return ATTACHMENT_TYPES[name.split(".").pop()?.toLowerCase() ?? ""]
}
export function attachmentLimit(mediaType: string) {
  return mediaType === "application/pdf" ? 5_500_000 : 8_000_000
}
export function attachmentUrl(id: string, conversationId: string) {
  return `/api/primo/attachments?id=${encodeURIComponent(id)}&conversationId=${encodeURIComponent(conversationId)}`
}
