import { describe, expect, it } from "vitest"
import type { UIMessage } from "ai"

import { fitPrimoMessages } from "@/lib/primo/messages"

function message(
  id: string,
  role: "user" | "assistant",
  text: string
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] }
}

describe("fitPrimoMessages", () => {
  it("drops oldest whole messages when the budget is full", () => {
    const messages = [
      message("old", "user", "12345"),
      message("middle", "assistant", "12345"),
      message("new", "user", "12345"),
    ]
    expect(
      fitPrimoMessages(messages, { maxChars: 10 }).map((row) => row.id)
    ).toEqual(["middle", "new"])
  })

  it("always keeps the newest user message even when it exceeds the budget", () => {
    const messages = [
      message("old", "assistant", "small"),
      message("new", "user", "a message larger than this tiny budget"),
    ]
    expect(fitPrimoMessages(messages, { maxChars: 4 })).toEqual([messages[1]])
  })

  it("never splits a message to fill the remaining space", () => {
    const messages = [
      message("old", "user", "123"),
      message("too-large", "assistant", "123456"),
      message("new", "user", "123"),
    ]
    expect(
      fitPrimoMessages(messages, { maxChars: 8 }).map((row) => row.id)
    ).toEqual(["new"])
  })
})
