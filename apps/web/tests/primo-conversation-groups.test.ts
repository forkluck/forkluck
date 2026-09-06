import { describe, expect, it } from "vitest"

import type { PrimoConversationSummary } from "@/lib/backend/types"
import { groupConversationsByDate } from "@/lib/primo/conversation-groups"

function row(id: string, date: string): PrimoConversationSummary {
  const value = new Date(`${date}T12:00:00`)
  return {
    id,
    title: id,
    isArchived: false,
    archivedAt: null,
    lastMessageAt: value,
    createdAt: value,
    updatedAt: value,
  }
}

describe("groupConversationsByDate", () => {
  it("uses the recent, month, and year buckets in list order", () => {
    const groups = groupConversationsByDate(
      [
        row("today", "2026-09-03"),
        row("yesterday", "2026-09-02"),
        row("week", "2026-08-29"),
        row("month", "2026-08-10"),
        row("july", "2026-07-01"),
        row("year", "2025-12-01"),
      ],
      new Date("2026-09-03T15:00:00")
    )
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Previous 30 days",
      "July",
      "2025",
    ])
  })
})
