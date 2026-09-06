// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const updateAccountName = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/settings/actions", () => ({ updateAccountName }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

import { AccountDetailsDialog } from "@/components/settings/account-details-dialog"

const USER = { id: "usr-1", name: "Ana Reyes", email: "ana@example.com" }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function rename(onOpenChange = vi.fn()) {
  render(<AccountDetailsDialog user={USER} open onOpenChange={onOpenChange} />)
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Ana R." },
  })
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
  })
}

describe("the account details dialog", () => {
  it("closes only once the save landed", async () => {
    updateAccountName.mockResolvedValue({ ok: true })
    const onOpenChange = vi.fn()

    await rename(onOpenChange)

    expect(updateAccountName).toHaveBeenCalledWith("Ana R.")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open and says why when the save did not land", async () => {
    updateAccountName.mockResolvedValue({ error: "Backend is down" })
    const onOpenChange = vi.fn()

    await rename(onOpenChange)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
  })
})
