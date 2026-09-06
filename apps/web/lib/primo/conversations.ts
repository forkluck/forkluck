import type {
  PrimoConversation,
  PrimoConversationList,
  PrimoConversationSummary,
} from "@/lib/backend/types"

async function readConversations<Result>(
  params: URLSearchParams
): Promise<Result | { error: string }> {
  try {
    const response = await fetch(`/api/primo/conversations?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    const result = await response.json()
    if ("error" in result) return { error: result.error }
    if (!response.ok) throw new Error("Conversation read failed")
    return result as Result
  } catch {
    return {
      error: "Couldn’t load chats. Check your connection and try again.",
    }
  }
}

function withDates(row: PrimoConversationSummary): PrimoConversationSummary {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt) : null,
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
  }
}

export async function listPrimoConversations({
  page = 1,
  archived = false,
  query = "",
}: {
  page?: number
  archived?: boolean
  query?: string
} = {}) {
  const result = await readConversations<PrimoConversationList>(
    new URLSearchParams({
      page: String(page),
      archived: archived ? "1" : "0",
      q: query,
    })
  )
  if ("error" in result) return result
  return { ...result, items: result.items.map(withDates) }
}

export async function loadPrimoConversation(id: string) {
  const result = await readConversations<{ item: PrimoConversation }>(
    new URLSearchParams({ id })
  )
  if ("error" in result) return result
  return {
    item: {
      ...result.item,
      conversation: withDates(result.item.conversation),
      messages: result.item.messages.map((message) => ({
        ...message,
        createdAt: new Date(message.createdAt),
      })),
    },
  }
}
