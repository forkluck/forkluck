// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveAnthropicKey = vi.hoisted(() => vi.fn())
const deleteAnthropicKey = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveAnthropicKey,
  deleteAnthropicKey,
}))
vi.mock("next/navigation", () => {
  const router = { refresh }
  return { useRouter: () => router }
})

import { AiKeyDialog } from "@/components/invoices/ai-key-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("AiKeyDialog never-grey save", () => {
  beforeEach(() => {
    saveAnthropicKey.mockResolvedValue({ ok: true })
  })

  function open() {
    render(<AiKeyDialog configured={false} hint={null} />)
    fireEvent.click(screen.getByRole("button", { name: "AI key (optional)" }))
  }

  it("keeps Save key enabled while the key is empty", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for the key instead of calling the action when empty", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    expect(saveAnthropicKey).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter your Anthropic API key."
    )
  })

  it("saves once the key is filled in", () => {
    open()
    fireEvent.change(screen.getByLabelText("API key (sk-ant-…)"), {
      target: { value: "sk-ant-abc" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    expect(saveAnthropicKey).toHaveBeenCalledWith("sk-ant-abc")
  })
})
