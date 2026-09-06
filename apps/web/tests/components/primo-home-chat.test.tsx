// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  registerInline: vi.fn(() => undefined),
  send: vi.fn(),
  stop: vi.fn(),
  newChat: vi.fn(),
  messages: [] as unknown[],
  conversationProps: vi.fn(),
}))

vi.mock("@/components/primo/primo-provider", () => ({
  usePrimo: () => ({
    chat: { messages: mocks.messages, status: "ready", stop: mocks.stop },
    registerInline: mocks.registerInline,
    send: mocks.send,
    newChat: mocks.newChat,
    conversationId: "conversation-1",
  }),
}))
vi.mock("@/components/primo/primo-composer", () => ({
  PrimoComposer: () => <textarea aria-label="Message Primo" />,
}))
vi.mock("@/components/primo/primo-conversation", () => ({
  PrimoConversation: (props: unknown) => {
    mocks.conversationProps(props)
    return <div>Conversation</div>
  },
}))

vi.mock("@/components/primo/primo-recent", () => ({
  PrimoRecent: () => <button>Recent</button>,
}))

import { PrimoHomeChat } from "@/components/primo/primo-home-chat"

afterEach(() => {
  cleanup()
  mocks.send.mockReset()
  mocks.newChat.mockReset()
  mocks.messages = []
})

describe("PrimoHomeChat", () => {
  it("passes kitchen context to the shared conversation", () => {
    render(<PrimoHomeChat userName="Ada" />)

    expect(mocks.conversationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ home: true, userName: "Ada" })
    )
  })

  it("offers New when a conversation is showing", () => {
    mocks.messages = [{ id: "message-1" }]
    render(<PrimoHomeChat userName="Ada" />)
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    expect(mocks.newChat).toHaveBeenCalled()
  })
})
