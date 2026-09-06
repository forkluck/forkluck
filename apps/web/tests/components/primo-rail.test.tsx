// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const state = vi.hoisted(() => ({
  open: true,
  isDesktop: true,
  inlineCount: 0,
  setOpen: vi.fn(),
  chat: { messages: [] as unknown[] },
  newChat: vi.fn(),
}))

vi.mock("@/components/primo/primo-provider", () => ({
  usePrimo: () => state,
}))
vi.mock("@/components/primo/primo-conversation", () => ({
  PrimoConversation: () => <div>Persistent conversation</div>,
}))
vi.mock("@/components/primo/primo-recent", () => ({
  PrimoRecent: () => <button>Recent</button>,
}))

import { PrimoRail } from "@/components/primo/primo-rail"

afterEach(cleanup)
beforeEach(() => {
  state.open = true
  state.isDesktop = true
  state.inlineCount = 0
})

describe("Primo responsive surface", () => {
  it("uses the application rail on desktop", () => {
    render(<PrimoRail userName="Ada" onClose={vi.fn()} />)
    expect(screen.getByRole("complementary", { name: "Primo" })).toBeDefined()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("uses a full-screen dialog below lg", () => {
    state.isDesktop = false
    render(<PrimoRail userName="Ada" onClose={vi.fn()} />)
    expect(screen.getByRole("dialog", { name: "Primo" }).className).toContain(
      "h-dvh"
    )
  })

  it("stays hidden while Home owns the inline conversation", () => {
    state.inlineCount = 1
    render(<PrimoRail userName="Ada" onClose={vi.fn()} />)
    expect(screen.queryByText("Persistent conversation")).toBeNull()
  })
})
