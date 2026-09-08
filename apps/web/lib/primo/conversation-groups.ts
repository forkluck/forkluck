import type { PrimoConversationSummary } from "@/lib/backend/types"
import { formatInZone } from "@/lib/datetime"

export type PrimoConversationGroup = {
  label: string
  items: PrimoConversationSummary[]
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

export function groupConversationsByDate(
  conversations: PrimoConversationSummary[],
  now = new Date()
): PrimoConversationGroup[] {
  const today = startOfDay(now)
  const groups = new Map<string, PrimoConversationSummary[]>()
  for (const conversation of conversations) {
    const date = conversation.lastMessageAt ?? conversation.updatedAt
    const day = startOfDay(date)
    const days = Math.floor((today.valueOf() - day.valueOf()) / 86_400_000)
    const label =
      days <= 0
        ? "Today"
        : days === 1
          ? "Yesterday"
          : days <= 7
            ? "Previous 7 days"
            : days <= 30
              ? "Previous 30 days"
              : day.getFullYear() === today.getFullYear()
                ? formatInZone(
                    Date.UTC(day.getFullYear(), day.getMonth(), 1),
                    "UTC",
                    { month: "long" }
                  )
                : String(day.getFullYear())
    const rows = groups.get(label) ?? []
    rows.push(conversation)
    groups.set(label, rows)
  }
  return [...groups].map(([label, items]) => ({ label, items }))
}
