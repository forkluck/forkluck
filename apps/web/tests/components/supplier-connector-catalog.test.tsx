// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const connectConnector = vi.hoisted(() => vi.fn())
const disconnectConnector = vi.hoisted(() => vi.fn())
const enqueueConnectorSync = vi.hoisted(() => vi.fn())
const loadConnectorSyncRun = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ add: vi.fn() }))
const completeConnectorAuthorization = vi.hoisted(() => vi.fn())

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/invoices/actions", () => ({
  completeConnectorAuthorization,
  connectConnector,
  deleteAnthropicKey: vi.fn(),
  disconnectConnector,
  enqueueConnectorSync,
  loadConnectorSyncRun,
  saveAnthropicKey: vi.fn(),
}))
vi.mock("next/navigation", () => {
  const router = { refresh, replace }
  return { useRouter: () => router }
})
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }))

import { SupplierConnectorCatalog } from "@/components/settings/supplier-connector-catalog"
import type { InvoicesOverview } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "/")
  vi.resetAllMocks()
})

const acme = {
  key: "acme",
  displayName: "Acme Produce",
  description: "Invoices and credits from your Acme Produce account.",
  icon: "package",
  capabilities: ["invoices", "credit_memos"],
  available: true,
} satisfies InvoicesOverview["connectors"]["providers"][number]

function catalog(connectors: InvoicesOverview["connectors"]) {
  render(<SupplierConnectorCatalog connectors={connectors} />)
}

describe("the supplier connector catalog", () => {
  it("shows the no-service state", () => {
    catalog({ configured: false, providers: [], connections: [] })

    expect(screen.getByText("No supplier connectors configured")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull()
  })

  it("offers a provider-hosted connection without asking for a supplier password", () => {
    catalog({ configured: true, providers: [acme], connections: [] })

    expect(screen.getByText("Acme Produce")).toBeTruthy()
    expect(screen.getByText("Invoices · Credit memos")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy()
    expect(screen.queryByText(/username/i)).toBeNull()
    expect(screen.queryByText(/password/i)).toBeNull()
  })

  it("shows a connection that needs attention as reconnectable", () => {
    catalog({
      configured: true,
      providers: [acme],
      connections: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          providerKey: "acme",
          status: "needs_reconnect",
          lastSyncedAt: null,
          lastError: "The supplier needs you to sign in again.",
          lastErrorCode: "authorization_rejected",
          latestRun: null,
        },
      ],
    })

    expect(screen.getByText("Needs attention")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy()
    expect(screen.queryByText("Connected")).toBeNull()
  })

  it("queues a manual sync and releases the control", async () => {
    enqueueConnectorSync.mockResolvedValue({
      run: { id: "22222222-2222-4222-8222-222222222222" },
    })
    catalog({
      configured: true,
      providers: [acme],
      connections: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          providerKey: "acme",
          status: "connected",
          lastSyncedAt: null,
          lastError: null,
          lastErrorCode: null,
          latestRun: null,
        },
      ],
    })

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }))
    expect(enqueueConnectorSync).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111"
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sync now" })).toHaveProperty(
        "disabled",
        false
      )
    )
    // The action revalidates, so its answer is the refresh.
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("supplier authorization return", () => {
  it.each([false, true])(
    "cleans the callback URL without a navigation (exchange failure: %s)",
    async (failed) => {
      window.history.replaceState(
        null,
        "",
        "/integrations/suppliers/connections?state=synthetic&code=synthetic"
      )
      completeConnectorAuthorization.mockResolvedValue(
        failed
          ? { error: "Connection failed" }
          : { connection: { id: "synthetic" } }
      )
      render(
        <SupplierConnectorCatalog
          connectors={{ configured: true, providers: [acme], connections: [] }}
          callback={{ state: "synthetic", code: "synthetic", error: null }}
        />
      )
      await waitFor(() => expect(toast.add).toHaveBeenCalled())
      expect(completeConnectorAuthorization).toHaveBeenCalledOnce()
      expect(window.location.search).toBe("")
      expect(replace).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
      expect(toast.add).toHaveBeenCalledWith(
        failed
          ? { title: "Connection failed", type: "error" }
          : { title: "Supplier connected" }
      )
    }
  )

  it("removes a rejected callback without exposing provider error details", async () => {
    window.history.replaceState(
      null,
      "",
      "/integrations/suppliers/connections?error=private-details"
    )
    render(
      <SupplierConnectorCatalog
        connectors={{ configured: true, providers: [acme], connections: [] }}
        callback={{ state: null, code: null, error: "private-details" }}
      />
    )
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        title: "Supplier connection wasn’t completed.",
        type: "error",
      })
    )
    expect(window.location.search).toBe("")
    expect(completeConnectorAuthorization).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
