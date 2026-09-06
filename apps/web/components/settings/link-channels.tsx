"use client"

import * as React from "react"
import {
  MoreHorizontal,
  RefreshCw,
  Store,
  TriangleAlert,
  Unplug,
} from "lucide-react"

import { disconnectPos } from "@/app/(app)/settings/actions"
import {
  enqueuePosSync,
  loadPosSyncRun,
  retryPosSync,
} from "@/app/(app)/sales/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { ChannelSetupDialog } from "@/components/settings/channel-setup-dialog"
import { InitialPosSync } from "@/components/settings/initial-pos-sync"
import { IntegrationRow } from "@/components/settings/integration-row"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { StatusDot } from "@/components/ui/status-dot"
import { useToast } from "@/components/ui/toast"
import type { PosConnectionRow, PosSyncRun } from "@/lib/backend/types"
import { formatInZone } from "@/lib/datetime"
import { activeSyncRun, syncRunForConnection } from "@/lib/pos-sync-runs"
import { useRefresh } from "@/hooks/use-refresh"

const ERROR_COPY: Record<string, string> = {
  denied: "The connection was cancelled on the provider’s page.",
  state_expired: "The connection attempt expired — try connecting again.",
  exchange_failed:
    "The provider rejected the connection. Try again in a minute.",
  hmac_invalid: "The callback failed a security check and was ignored.",
  bad_shop: "Enter your store’s .myshopify.com domain.",
  not_configured: "This integration isn’t configured on the server yet.",
  unsupported_currency:
    "That account reports sales in a currency Forkluck can’t track yet.",
}

const POLL_INTERVAL_MS = 3_000

const STALE_PAGE_MESSAGE =
  "The page may be out of date. Refresh it and try again."

type Provider = "square" | "shopify"

const CHANNELS: Array<{ provider: Provider; name: string; blurb: string }> = [
  {
    provider: "square",
    name: "Square",
    blurb: "Sales, items, and modifiers from your Square account.",
  },
  {
    provider: "shopify",
    name: "Shopify",
    blurb: "Orders and products from your Shopify store.",
  },
]

function lastSyncedLabel(connection: PosConnectionRow, timeZone: string) {
  if (!connection.lastSyncedAt) return "Never synced"
  const at = formatInZone(new Date(connection.lastSyncedAt), timeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  return `Last synced ${at}`
}

function channelIdentity(connection: PosConnectionRow) {
  return connection.provider === "shopify"
    ? connection.shopDomain
    : `Merchant ${connection.merchantId || "unknown"}`
}

/**
 * Queue one durable provider sync. The worker owns continuation and retries,
 * so closing this page cannot cancel the merchant's import.
 */
function SyncNowButton({
  connection,
  initialSyncing,
  run,
}: {
  connection: PosConnectionRow
  initialSyncing: boolean
  run?: PosSyncRun
}) {
  const toast = useToast()
  const [busy, startSync] = React.useTransition()
  const name = connection.provider === "square" ? "Square" : "Shopify"

  // The queue actions revalidate this route themselves; the transition keeps
  // the button disabled until that fresh payload has been applied.
  const sync = () =>
    startSync(async () => {
      try {
        const result =
          run?.status === "failed"
            ? await retryPosSync(run.id)
            : await enqueuePosSync(connection.provider)
        if ("error" in result) {
          toast.add({
            title: `Couldn’t start the ${name} sync`,
            description: result.error,
            type: "error",
          })
          return
        }
        toast.add({
          title: `${name} sync started`,
          description:
            "We’ll pull in your latest sales in the background. This can take a few minutes.",
        })
      } catch {
        toast.add({
          title: "Couldn’t start the sync",
          description: STALE_PAGE_MESSAGE,
          type: "error",
        })
      }
    })

  const running =
    busy ||
    initialSyncing ||
    run?.status === "queued" ||
    run?.status === "running"

  return (
    <>
      <Button type="button" disabled={running} onClick={sync}>
        <RefreshCw strokeWidth={1.8} aria-hidden="true" />
        {run?.status === "failed"
          ? "Retry sync"
          : running
            ? run?.status === "running"
              ? "Syncing…"
              : "Queued…"
            : "Sync now"}
      </Button>
      {/* Progress stays available to assistive technology without moving the
          row. The visible running count lives in the toast. */}
      <span aria-live="polite" className="sr-only">
        {run?.status === "running"
          ? `${name} sync has imported ${run.progress.imported ?? 0} lines.`
          : ""}
      </span>
    </>
  )
}

function ChannelRow({
  name,
  blurb,
  connection,
  initialSyncing,
  run,
  connectHref,
  onSetup,
}: {
  name: string
  blurb: string
  connection: PosConnectionRow | undefined
  initialSyncing: boolean
  run?: PosSyncRun
  /** Square in production links out to OAuth instead of asking for a token. */
  connectHref?: string
  onSetup: () => void
}) {
  const { timezone } = useBusinessSettings()
  const toast = useToast()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const needsReconnect = connection?.status === "needs_reconnect"
  const disconnecting = connection?.status === "disconnecting"
  const runFailed = run?.status === "failed"
  const syncFailed =
    (runFailed || Boolean(connection?.lastError)) && !needsReconnect
  const missingHistoryScope =
    connection?.provider === "shopify" &&
    !connection.scopes.split(",").includes("read_all_orders")

  const disconnect = async () => {
    if (!connection || busy) return
    setBusy(true)
    try {
      const result = await disconnectPos(connection.provider)
      if ("error" in result) {
        toast.add({
          title: `Couldn’t disconnect ${name}`,
          description: result.error,
          type: "error",
        })
        return
      }
      setConfirmOpen(false)
      toast.add({ title: `${name} disconnected`, description: result.note })
    } catch {
      toast.add({
        title: `Couldn’t disconnect ${name}`,
        description: STALE_PAGE_MESSAGE,
        type: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  const syncLabel = !connection
    ? ""
    : disconnecting
      ? "Disconnecting…"
      : run?.status === "queued"
        ? "Sync queued…"
        : run?.status === "running"
          ? `Syncing sales… ${run.progress.linesFetched ?? 0} lines read`
          : runFailed
            ? "Last sync failed"
            : initialSyncing
              ? "Syncing initial sales…"
              : lastSyncedLabel(connection, timezone)
  const meta = !connection
    ? blurb
    : `${channelIdentity(connection)} · ${syncLabel}`
  const syncError = runFailed ? run.error : connection?.lastError

  const status = !connection ? (
    <StatusDot label="Not connected" tone="off" />
  ) : disconnecting ? (
    <StatusDot label="Disconnecting" tone="off" />
  ) : needsReconnect ? (
    <StatusDot label="Needs reconnect" tone="attention" />
  ) : syncFailed ? (
    <StatusDot label="Sync error" tone="error" />
  ) : (
    <StatusDot label="Connected" tone="on" />
  )

  return (
    <>
      <IntegrationRow
        logo={{ src: `/channel-${name.toLowerCase()}.png`, alt: "" }}
        icon={Store}
        name={name}
        status={status}
        description={meta}
        error={syncError || null}
        note={
          missingHistoryScope
            ? "Shopify limits merchant-created apps to the last 60 days of orders, so history starts there."
            : null
        }
        actions={
          <>
            {connection && !needsReconnect && !disconnecting ? (
              <SyncNowButton
                connection={connection}
                initialSyncing={initialSyncing}
                run={run}
              />
            ) : null}
            {!connection && connectHref ? (
              <Button nativeButton={false} render={<a href={connectHref} />}>
                Connect
              </Button>
            ) : null}
            {!connection && !connectHref ? (
              <Button type="button" onClick={onSetup}>
                Connect
              </Button>
            ) : null}
            {needsReconnect ? (
              connectHref ? (
                <Button nativeButton={false} render={<a href={connectHref} />}>
                  Reconnect
                </Button>
              ) : (
                <Button type="button" onClick={onSetup}>
                  Reconnect
                </Button>
              )
            ) : null}
            {connection ? (
              <Menu>
                <MenuTrigger
                  aria-label={`More ${name} actions`}
                  render={<Button variant="ghost" size="icon" />}
                >
                  <MoreHorizontal aria-hidden="true" />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => setConfirmOpen(true)}
                  >
                    <Unplug aria-hidden="true" />
                    Disconnect
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </>
        }
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disconnect ${name}?`}
        description={
          connection?.provider === "shopify"
            ? "New sales stop syncing and the stored token is removed. To fully revoke access, also uninstall Forkluck from your Shopify admin."
            : "New sales stop syncing to Forkluck. You can reconnect the channel anytime."
        }
        confirmLabel={busy ? "Disconnecting…" : "Disconnect"}
        pending={busy}
        onConfirm={disconnect}
      />
    </>
  )
}

/**
 * Link channels: one bordered card, one row per sales source. A row carries
 * the channel's name and status, the merchant it points at and when it last
 * synced, then the two things you can do with it.
 */
export function LinkChannels({
  connections,
  syncRuns,
  squareSandboxEnabled,
  connected,
  integrationError,
  errorProvider,
}: {
  connections: PosConnectionRow[]
  syncRuns: PosSyncRun[]
  squareSandboxEnabled: boolean
  connected?: string
  integrationError?: string
  errorProvider?: string
}) {
  const { refresh } = useRefresh()
  // Watch only the run itself while it works, and reload the route once when
  // it finishes — a repeating refresh() re-fetched every card here.
  const activeRunId = activeSyncRun(syncRuns, connections)?.id ?? null
  const [watchedRun, setWatchedRun] = React.useState<PosSyncRun | null>(null)
  React.useEffect(() => {
    if (!activeRunId) return
    let stopped = false
    const timer = window.setInterval(() => {
      loadPosSyncRun(activeRunId)
        .then((run) => {
          if (stopped) return
          setWatchedRun(run)
          // A run that vanished is as finished as one that failed.
          if (run && (run.status === "queued" || run.status === "running")) {
            return
          }
          window.clearInterval(timer)
          void refresh()
        })
        // A dropped poll is transient; the next tick asks again.
        .catch(() => {})
    }, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activeRunId, refresh])

  // The setup modal stays mounted after it closes so focus returns to the
  // Connect button; `nonce` is its key, so the next open starts a clean form.
  const [setup, setSetup] = React.useState<{
    provider: Provider
    open: boolean
    nonce: number
  } | null>(null)
  const [completedInitialProviders, setCompletedInitialProviders] =
    React.useState<ReadonlySet<Provider>>(() => new Set())
  const newlyConnected =
    connected === "square" || connected === "shopify" ? connected : null
  // A channel linked in this session, or one that has never finished a sync,
  // is still pulling its first history — the row says so while it runs.
  const initialSyncingProvider = [
    newlyConnected,
    ...connections
      .filter(
        (row) => row.status === "active" && !row.lastSyncedAt && !row.lastError
      )
      .map((row) => row.provider),
  ].find(
    (provider): provider is Provider =>
      (provider === "square" || provider === "shopify") &&
      !completedInitialProviders.has(provider)
  )

  const finishInitialSync = React.useCallback((provider: Provider) => {
    setCompletedInitialProviders((current) => new Set(current).add(provider))
  }, [])

  const openSetup = React.useCallback((provider: Provider) => {
    setSetup((current) => ({
      provider,
      open: true,
      nonce: (current?.nonce ?? 0) + 1,
    }))
  }, [])
  const setupConnection = connections.find(
    (row) => row.provider === setup?.provider
  )

  return (
    <>
      {initialSyncingProvider ? (
        <InitialPosSync
          key={initialSyncingProvider}
          provider={initialSyncingProvider}
          onComplete={finishInitialSync}
        />
      ) : null}

      {integrationError ? (
        <div className="mb-4 flex max-w-[760px] items-center gap-2.5 rounded-lg border border-warning-border bg-warning-fill px-3.5 py-3 text-sm text-warning-foreground">
          <TriangleAlert
            className="size-4 flex-none text-warning"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0">
            {errorProvider === "shopify" ? "Shopify: " : "Square: "}
            {ERROR_COPY[integrationError] ?? "The connection didn’t complete."}
          </span>
        </div>
      ) : null}

      <div className="max-w-[760px] overflow-hidden rounded-xl border border-border">
        {CHANNELS.map((channel) => {
          const connection = connections.find(
            (row) => row.provider === channel.provider
          )
          const serverRun = syncRunForConnection(syncRuns, connection)
          // The poll above carries fresher progress than the last render.
          const run =
            watchedRun && watchedRun.id === serverRun?.id
              ? watchedRun
              : serverRun
          return (
            <ChannelRow
              key={channel.provider}
              name={channel.name}
              blurb={channel.blurb}
              connection={connection}
              run={run}
              initialSyncing={initialSyncingProvider === channel.provider}
              connectHref={
                channel.provider === "square" && !squareSandboxEnabled
                  ? "/api/integrations/square/connect"
                  : undefined
              }
              onSetup={() => openSetup(channel.provider)}
            />
          )
        })}
      </div>

      {setup ? (
        <ChannelSetupDialog
          key={setup.nonce}
          provider={setup.provider}
          reconnect={setupConnection?.status === "needs_reconnect"}
          open={setup.open}
          onOpenChange={(next) =>
            setSetup((current) =>
              current ? { ...current, open: next } : current
            )
          }
        />
      ) : null}
    </>
  )
}
