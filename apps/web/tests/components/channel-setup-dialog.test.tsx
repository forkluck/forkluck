// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const connectSquareSandboxToken = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())

vi.mock("@/app/(app)/settings/actions", () => ({
  connectShopifyCredentials: vi.fn(),
  connectShopifyToken: vi.fn(),
  connectSquareSandboxToken,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }))

import { ChannelSetupDialog } from "@/components/settings/channel-setup-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function connect(onOpenChange = vi.fn()) {
  render(
    <ChannelSetupDialog
      provider="square"
      reconnect={false}
      open
      onOpenChange={onOpenChange}
    />
  )
  fireEvent.change(screen.getByLabelText("Sandbox access token (EAAA…)"), {
    target: { value: "EAAAsandbox" },
  })
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
  })
}

describe("the channel setup dialog", () => {
  it("closes only once the connection landed", async () => {
    connectSquareSandboxToken.mockResolvedValue({ ok: true })
    const onOpenChange = vi.fn()

    await connect(onOpenChange)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(replace).toHaveBeenCalledWith(
      "/integrations/sales/connections?connected=square"
    )
  })

  it("stays open and says why when the connection did not land", async () => {
    connectSquareSandboxToken.mockResolvedValue({ error: "Square said no" })
    const onOpenChange = vi.fn()

    await connect(onOpenChange)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Square said no")
  })
})
