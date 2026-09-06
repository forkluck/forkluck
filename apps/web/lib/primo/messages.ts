import { isToolUIPart, type UIMessage } from "ai"
import { z } from "zod"
import { attachmentSchema, type PrimoAttachment } from "./attachments"

export const primoMentionSchema = z.strictObject({
  kind: z.enum(["recipe", "product"]),
  label: z.string().min(1).max(200),
  ref: z.string().regex(/^(rcp|prd)_[0-9abcdefghjkmnpqrstvwxyz]{12}$/),
})

export const primoMessageMetadataSchema = z.strictObject({
  mentions: z.array(primoMentionSchema).max(10).optional(),
  attachmentIds: z.array(z.uuid()).max(5).optional(),
  attachments: z.array(attachmentSchema).max(5).optional(),
  createdAt: z.string().optional(),
  finishReason: z.string().optional(),
})

export type PrimoMention = z.infer<typeof primoMentionSchema>
export type PrimoMessageMetadata = {
  mentions?: PrimoMention[]
  attachmentIds?: string[]
  attachments?: PrimoAttachment[]
  createdAt?: string
  finishReason?: string
}
export type PrimoDataTypes = {
  title: { conversationId: string; title: string }
}
export type PrimoUIMessage = UIMessage<PrimoMessageMetadata, PrimoDataTypes> & {
  status?: "complete" | "aborted" | "error"
  createdAt?: Date | string
  feedback?: "" | "up" | "down"
  feedbackComment?: string
}

/** A transport ending is not proof that every requested step finished. */
export function primoTurnStatus(
  message: UIMessage,
  {
    aborted = false,
    errored = false,
    finishReason,
  }: { aborted?: boolean; errored?: boolean; finishReason?: string } = {}
): NonNullable<PrimoUIMessage["status"]> {
  if (errored) return "error"
  if (aborted) return "aborted"
  if (
    finishReason === "length" ||
    finishReason === "error" ||
    (finishReason === "tool-calls" &&
      message.parts.findLast(isToolUIPart)?.state === "output-error") ||
    message.parts.some(
      (part) =>
        isToolUIPart(part) &&
        (part.state === "input-streaming" || part.state === "input-available")
    )
  )
    return "error"
  return "complete"
}

export function sanitizePrimoMessages(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return []
    const parts = message.parts.flatMap((part) =>
      part.type === "text" && part.text.trim()
        ? [{ type: "text" as const, text: part.text }]
        : []
    )
    if (!parts.length) return []
    return [{ id: message.id, role: message.role, parts }]
  })
}

export function primoMessageCharacters(messages: UIMessage[]): number[] {
  return messages.map((message) =>
    message.parts.reduce(
      (total, part) => total + (part.type === "text" ? part.text.length : 0),
      0
    )
  )
}

export function primoMessageText(message: UIMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
}

export function fitPrimoMessages<Messages extends UIMessage>(
  messages: Messages[],
  { maxChars = 24_000 }: { maxChars?: number } = {}
): Messages[] {
  const newestUserIndex = messages.findLastIndex(
    (message) => message.role === "user"
  )
  const kept = new Set<number>()
  let used = 0
  if (newestUserIndex >= 0) {
    kept.add(newestUserIndex)
    used = primoMessageText(messages[newestUserIndex]!).length
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (index === newestUserIndex) continue
    const message = messages[index]!
    const size = primoMessageText(message).length
    if (used + size > maxChars) break
    kept.add(index)
    used += size
  }
  return messages.filter((_, index) => kept.has(index))
}
