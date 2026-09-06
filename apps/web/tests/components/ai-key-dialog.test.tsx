// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const saveAnthropicKey = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/invoices/actions", () => ({
  saveAnthropicKey,
  deleteAnthropicKey: vi.fn(),
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

function save() {
  render(<AiKeyDialog configured={false} hint={null} />)
  fireEvent.click(screen.getByRole("button", { name: "AI key (optional)" }))
  fireEvent.change(screen.getByLabelText("API key (sk-ant-…)"), {
    target: { value: "sk-ant-abc" },
  })
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
  })
}

describe("the AI key dialog", () => {
  it("closes only once the key was accepted", async () => {
    saveAnthropicKey.mockResolvedValue({ ok: true })

    await save()

    expect(screen.queryByLabelText("API key (sk-ant-…)")).toBeNull()
    expect(refresh).toHaveBeenCalled()
  })

  it("reopens clean once a key was saved", async () => {
    saveAnthropicKey.mockResolvedValue({ ok: true })

    await save()
    fireEvent.click(screen.getByRole("button", { name: "AI key (optional)" }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    await vi.waitFor(() =>
      expect(screen.queryByLabelText("API key (sk-ant-…)")).toBeNull()
    )
  })

  it("stays open and says why when the key was refused", async () => {
    saveAnthropicKey.mockResolvedValue({ error: "Anthropic said no" })

    await save()

    expect(screen.getByRole("alert").textContent).toContain("Anthropic said no")
    expect(screen.getByLabelText("API key (sk-ant-…)")).toBeTruthy()
    expect(refresh).not.toHaveBeenCalled()
  })
})
