"use client"

import * as React from "react"
import {
  Boxes,
  Cable,
  type LucideIcon,
  MoreHorizontal,
  PackageOpen,
  PlugZap,
  RefreshCw,
  Store,
  Unplug,
} from "lucide-react"

import {
  completeConnectorAuthorization,
  connectConnector,
  disconnectConnector,
  enqueueConnectorSync,
} from "@/app/(app)/invoices/actions"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { useToast } from "@/components/ui/toast"
import { IntegrationRow } from "@/components/settings/integration-row"
import { useConnectorRun } from "@/components/settings/use-connector-run"
import { StatusDot } from "@/components/ui/status-dot"
import { connectorRow } from "@/lib/connector-status"
import { useRefresh } from "@/hooks/use-refresh"
import type {
  ConnectorConnection,
  ConnectorProvider,
  InvoicesOverview,
} from "@/lib/backend/types"

type ConnectorCatalog = InvoicesOverview["connectors"]

const TICK_MS = 30_000
const PROVIDER_ICONS: Record<string, LucideIcon> = {
  boxes: Boxes,
  cable: Cable,
  package: PackageOpen,
  store: Store,
}

/** The suppliers whose own mark we carry; the rest get the plug tile. */
const PROVIDER_LOGOS: Record<string, { src: string; alt: string }> = {
  baldor: { src: "/integrations/baldor.png", alt: "" },
}

function capabilityLabel(capabilities: string[]): string {
  const labels = capabilities.flatMap((capability) => {
    if (capability === "invoices") return ["Invoices"]
    if (capability === "credit_memos") return ["Credit memos"]
    if (capability === "purchase_orders") return ["Purchase orders"]
    return []
  })
  return labels.length ? labels.join(" · ") : "Supplier documents"
}

/** Consumes a callback once, replaces the URL, and never exposes its code. */
function ConnectorAuthorizationCallback({
  state,
  code,
  error,
}: {
  state: string | null
  code: string | null
  error: string | null
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const handled = React.useRef(false)

  React.useEffect(() => {
    if (handled.current) return
    if (error && !code) {
      handled.current = true
      // Provider error details are external input. Keep the user-facing copy
      // stable instead of rendering an untrusted supplier response verbatim.
      toast.add({
        title: "Supplier connection wasn’t completed.",
        type: "error",
      })
      window.history.replaceState(
        null,
        "",
        "/integrations/suppliers/connections"
      )
      return
    }
    if (!state || !code) return
    handled.current = true

    void completeConnectorAuthorization({ state, code }).then(
      async (result) => {
        // Remove the short-lived code whether the exchange succeeded or failed.
        // It must not survive copy/paste, browser history, or a later refresh.
        window.history.replaceState(
          null,
          "",
          "/integrations/suppliers/connections"
        )
        if ("error" in result) {
          toast.add({ title: result.error, type: "error" })
          return
        }
        // URL cleanup must not navigate to a prefetched, disconnected snapshot.
        await refresh()
        toast.add({ title: "Supplier connected" })
      }
    )
  }, [code, error, refresh, state, toast])

  return null
}

function ConnectorCard({
  provider,
  connection,
}: {
  provider: ConnectorProvider
  connection: ConnectorConnection | null
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const [now, setNow] = React.useState(() => Date.now())
  const [connecting, startConnect] = React.useTransition()
  const [syncing, startSync] = React.useTransition()
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  const liveRun = useConnectorRun(connection?.latestRun ?? null)

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const liveConnection = connection
    ? { ...connection, latestRun: liveRun }
    : null
  const row = connectorRow(provider, liveConnection, new Date(now))
  const Icon = PROVIDER_ICONS[provider.icon] ?? PlugZap

  const beginConnection = () =>
    startConnect(async () => {
      const result = await connectConnector(provider.key)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      // This is the connector-hosted page. Forkluck never collects or sees a
      // supplier password, and the callback returns only a one-time code.
      window.location.assign(result.authorizationUrl)
    })

  const sync = () => {
    if (!connection) return
    startSync(async () => {
      const result = await enqueueConnectorSync(connection.id)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      toast.add({ title: `${provider.displayName} sync started` })
      void refresh()
    })
  }

  const disconnect = async () => {
    if (!connection || disconnecting) return
    setDisconnecting(true)
    const result = await disconnectConnector(connection.id)
    if ("error" in result) {
      setDisconnecting(false)
      toast.add({ title: result.error, type: "error" })
      return
    }
    // Still "Disconnecting…" until the card reads as disconnected.
    await refresh()
    setDisconnecting(false)
    setDisconnectOpen(false)
    toast.add({ title: `${provider.displayName} disconnected` })
  }

  const primary =
    row.primary === "connect" || row.primary === "reconnect" ? (
      <Button
        type="button"
        variant={row.primary === "connect" ? "outline" : "default"}
        pending={connecting}
        onClick={beginConnection}
      >
        {row.primary === "reconnect" ? "Reconnect" : "Connect"}
      </Button>
    ) : row.primary === "sync" || row.primary === "retry" ? (
      <Button
        type="button"
        disabled={!row.canSync || syncing}
        pending={syncing}
        onClick={sync}
      >
        <RefreshCw aria-hidden="true" />
        {row.primary === "retry" ? "Try again" : "Sync now"}
      </Button>
    ) : null

  const status = !provider.available ? null : row.badge ? (
    <StatusDot
      label={row.badge.label}
      tone={
        row.badge.variant === "success"
          ? "on"
          : row.badge.variant === "warning"
            ? "attention"
            : "off"
      }
    />
  ) : (
    <StatusDot label="Not connected" tone="off" />
  )
  const capabilities = capabilityLabel(provider.capabilities)

  return (
    <>
      <IntegrationRow
        logo={PROVIDER_LOGOS[provider.key] ?? null}
        icon={Icon}
        name={provider.displayName}
        status={status}
        description={
          !provider.available
            ? "Not available for this workspace."
            : connection
              ? `${capabilities} · ${row.statusLine}`
              : capabilities
        }
        dimmed={!provider.available}
        actions={
          provider.available ? (
            <>
              {primary}
              {connection ? (
                <Menu>
                  <MenuTrigger
                    aria-label={`More ${provider.displayName} actions`}
                    render={<Button variant="ghost" size="icon" />}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </MenuTrigger>
                  <MenuContent>
                    {row.state !== "syncing" && row.state !== "connecting" ? (
                      <MenuItem
                        disabled={!row.canSync || syncing}
                        onClick={sync}
                      >
                        <RefreshCw aria-hidden="true" />
                        Sync now
                      </MenuItem>
                    ) : null}
                    {row.state !== "needs_reconnect" ? (
                      <MenuItem disabled={connecting} onClick={beginConnection}>
                        <Cable aria-hidden="true" />
                        Reconnect
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      className="text-destructive"
                      onClick={() => setDisconnectOpen(true)}
                    >
                      <Unplug aria-hidden="true" />
                      Disconnect
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : null}
            </>
          ) : null
        }
      />

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${provider.displayName}?`}
        description="New supplier documents will stop importing. Documents already imported into Forkluck stay exactly as they are."
        confirmLabel={disconnecting ? "Disconnecting…" : "Disconnect"}
        pending={disconnecting}
        onConfirm={disconnect}
      />
    </>
  )
}

/**
 * A small catalog, not a marketplace: the connector service alone decides
 * which private providers are available to this Forkluck deployment.
 */
export function SupplierConnectorCatalog({
  connectors,
  callback,
}: {
  connectors: ConnectorCatalog
  callback?: { state: string | null; code: string | null; error: string | null }
}) {
  const connectionsByProvider = new Map(
    connectors.connections.map((connection) => [
      connection.providerKey,
      connection,
    ])
  )

  return (
    <>
      <ConnectorAuthorizationCallback
        state={callback?.state ?? null}
        code={callback?.code ?? null}
        error={callback?.error ?? null}
      />
      {!connectors.configured ? (
        <p className="p-4 text-sm leading-[1.55] text-faint">
          <span>No supplier connectors configured</span> — this deployment has
          no connector service yet. The Drive folder and uploads work as usual.
        </p>
      ) : connectors.providers.length ? (
        connectors.providers.map((provider) => (
          <ConnectorCard
            key={provider.key}
            provider={provider}
            connection={connectionsByProvider.get(provider.key) ?? null}
          />
        ))
      ) : (
        <p className="p-4 text-sm leading-[1.55] text-faint">
          <span>No supplier connectors available</span> — your connector service
          is running, but it has not enabled a supplier for this workspace.
        </p>
      )}
    </>
  )
}
