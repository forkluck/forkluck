// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const connectShopifyCredentials = vi.hoisted(() => vi.fn())
const connectShopifyToken = vi.hoisted(() => vi.fn())
const connectSquareSandboxToken = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/settings/actions", () => ({
  connectShopifyCredentials,
  connectShopifyToken,
  connectSquareSandboxToken,
}))
vi.mock("next/navigation", () => {
  const router = { replace }
  return { useRouter: () => router }
})

import { ChannelSetupDialog } from "@/components/settings/channel-setup-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the Square sandbox Connect button", () => {
  beforeEach(() => {
    connectSquareSandboxToken.mockResolvedValue({ error: "stop here" })
  })

  function open() {
    render(
      <ChannelSetupDialog
        provider="square"
        reconnect={false}
        open
        onOpenChange={vi.fn()}
      />
    )
  }

  it("stays enabled while the token is empty", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for the token instead of connecting when empty", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectSquareSandboxToken).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toBe(
      "Paste your sandbox access token."
    )
  })

  it("connects once the token is filled in", () => {
    open()
    fireEvent.change(screen.getByLabelText("Sandbox access token (EAAA…)"), {
      target: { value: "EAAAsandbox" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectSquareSandboxToken).toHaveBeenCalledWith({
      accessToken: "EAAAsandbox",
    })
  })
})

describe("the Shopify Connect button", () => {
  beforeEach(() => {
    connectShopifyCredentials.mockResolvedValue({ error: "stop here" })
    connectShopifyToken.mockResolvedValue({ error: "stop here" })
  })

  function open() {
    render(
      <ChannelSetupDialog
        provider="shopify"
        reconnect={false}
        open
        onOpenChange={vi.fn()}
      />
    )
  }

  it("stays enabled while the fields are empty", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for each credential instead of connecting when empty", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectShopifyCredentials).not.toHaveBeenCalled()
    expect(screen.getByText("Enter your shop domain.")).toBeTruthy()
    expect(screen.getByText("Enter your client ID.")).toBeTruthy()
    expect(screen.getByText("Enter your client secret.")).toBeTruthy()
  })

  it("connects once the credentials are filled in", () => {
    open()
    fireEvent.change(screen.getByLabelText("Store domain (.myshopify.com)"), {
      target: { value: "teashop" },
    })
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "clientid-123" },
    })
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "secretkey-123" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectShopifyCredentials).toHaveBeenCalledWith({
      shopDomain: "teashop.myshopify.com",
      clientId: "clientid-123",
      clientSecret: "secretkey-123",
    })
  })

  it("asks for the token in the legacy tab when empty", () => {
    open()
    fireEvent.click(screen.getByText("Legacy app token"))
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectShopifyToken).not.toHaveBeenCalled()
    expect(screen.getByText("Enter your access token.")).toBeTruthy()
  })

  it("connects with a filled legacy token", () => {
    open()
    fireEvent.click(screen.getByText("Legacy app token"))
    fireEvent.change(screen.getByLabelText("Store domain (.myshopify.com)"), {
      target: { value: "teashop" },
    })
    fireEvent.change(
      screen.getByLabelText("Admin API access token (shpat_…)"),
      { target: { value: "shpat_123456" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectShopifyToken).toHaveBeenCalledWith({
      shopDomain: "teashop.myshopify.com",
      accessToken: "shpat_123456",
    })
  })
})
