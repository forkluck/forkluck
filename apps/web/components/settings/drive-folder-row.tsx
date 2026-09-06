"use client"

import * as React from "react"
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  Unplug,
} from "lucide-react"

import {
  checkDriveNow,
  connectDriveFolder,
  disconnectDriveFolder,
  retryDriveFile,
  skipDriveFiles,
  unskipDriveFile,
} from "@/app/(app)/invoices/actions"
import { IntegrationRow } from "@/components/settings/integration-row"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { StatusDot } from "@/components/ui/status-dot"
import { useToast } from "@/components/ui/toast"
import type { DriveFileRow, DriveFolderPayload } from "@/lib/backend/types"
import { relativeAgo } from "@/lib/connector-status"
import { useRefresh } from "@/hooks/use-refresh"

const LOGO = { src: "/integrations/google-drive.svg", alt: "" }

/**
 * One Google Drive folder as the receipts inbox, as a row of the Connections
 * list beside the supplier connectors. Access is a share, not a sign-in: the
 * merchant shares the folder with Forkluck's service-account address, so
 * there is nothing to authorize and nothing to renew. The credential behind
 * that address is server-only and never appears here.
 */
export function DriveFolderRow({
  folder,
  watch,
  readyCount,
  newCount,
  serviceAccountEmail,
}: Pick<DriveFolderPayload, "folder" | "watch"> & {
  /** Receipts the watcher has read and nobody has confirmed yet. */
  readyCount: number
  /** Files registered but not read yet. */
  newCount: number
  serviceAccountEmail: string | null
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const [now] = React.useState(() => Date.now())
  const [link, setLink] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const [connectOpen, setConnectOpen] = React.useState(false)
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [checking, startCheck] = React.useTransition()

  if (!serviceAccountEmail) {
    return (
      <IntegrationRow
        logo={LOGO}
        icon={FolderOpen}
        name="Google Drive"
        description="Not configured on this server."
        dimmed
      />
    )
  }

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(serviceAccountEmail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.add({ title: "Couldn't copy that address.", type: "error" })
    }
  }

  const connect = () =>
    startTransition(async () => {
      const result = await connectDriveFolder(link)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      void refresh().then(() => {
        setLink("")
        setConnectOpen(false)
        toast.add({ title: `Connected ${result.folder.folderName}` })
      })
    })

  const disconnect = () =>
    startTransition(async () => {
      const result = await disconnectDriveFolder()
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      void refresh().then(() => {
        setDisconnectOpen(false)
        toast.add({ title: "Drive folder disconnected" })
      })
    })

  /** The watcher polls on its own; this only asks for the same poll sooner.
   * Called Sync now, like every other source's button, though nothing is
   * written back to Drive. */
  const check = () =>
    startCheck(async () => {
      const result = await checkDriveNow()
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      void refresh()
    })

  if (!folder) {
    return (
      <>
        <IntegrationRow
          logo={LOGO}
          icon={FolderOpen}
          name="Google Drive"
          status={<StatusDot label="Not connected" tone="off" />}
          description="Receipts dropped into one Drive folder you share with Forkluck, read as they arrive."
          actions={
            <Button type="button" onClick={() => setConnectOpen(true)}>
              Connect
            </Button>
          }
        />
        <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect a Drive folder</DialogTitle>
              <DialogDescription>
                Forkluck reads the folder through a share, so there is nothing
                to sign in to.
              </DialogDescription>
            </DialogHeader>
            <ol className="flex list-decimal flex-col gap-2 pl-4 text-base leading-[1.55] text-muted-foreground">
              <li>
                In Drive, share the folder with{" "}
                <span className="font-medium text-foreground">
                  {serviceAccountEmail}
                </span>
                . Viewer is enough.
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="ml-1.5 align-middle"
                  onClick={() => void copyEmail()}
                >
                  {copied ? (
                    <Check strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <Copy strokeWidth={1.8} aria-hidden="true" />
                  )}
                  {copied ? "Copied" : "Copy address"}
                </Button>
              </li>
              <li>Paste the folder link here.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://drive.google.com/drive/folders/…"
                aria-label="Google Drive folder link"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                disabled={!link.trim()}
                pending={pending}
                onClick={connect}
              >
                Connect folder
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  // The watcher's own report, one line: the folder, the last poll, then what
  // it holds. A failed poll outranks the counts, as a connector's does.
  const checked = watch?.polledAt
    ? `Last checked ${relativeAgo(watch.polledAt, now)}`
    : "Not checked yet"
  const holding = [
    readyCount > 0 ? `${readyCount} ready to review` : null,
    newCount > 0 ? `${newCount} being read` : null,
  ].filter(Boolean)

  return (
    <>
      <IntegrationRow
        logo={LOGO}
        icon={FolderOpen}
        name="Google Drive"
        status={
          watch?.lastError ? (
            <StatusDot label="Last check failed" tone="attention" />
          ) : (
            <StatusDot label="Connected" tone="on" />
          )
        }
        description={`${[folder.folderName, checked, ...holding].join(" · ")}.`}
        error={watch?.lastError || null}
        actions={
          <>
            <Button type="button" pending={checking} onClick={check}>
              <RefreshCw aria-hidden="true" />
              Sync now
            </Button>
            <Menu>
              <MenuTrigger
                aria-label="More Google Drive actions"
                render={<Button variant="ghost" size="icon" />}
              >
                <MoreHorizontal aria-hidden="true" />
              </MenuTrigger>
              <MenuContent>
                <MenuLinkItem
                  href={`https://drive.google.com/drive/folders/${folder.folderId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  Open in Drive
                </MenuLinkItem>
                <MenuItem
                  className="text-destructive"
                  onClick={() => setDisconnectOpen(true)}
                >
                  <Unplug aria-hidden="true" />
                  Disconnect
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${folder.folderName}?`}
        description="New receipts in that folder will stop being read. Invoices already imported stay exactly as they are."
        confirmLabel={pending ? "Disconnecting…" : "Disconnect"}
        pending={pending}
        onConfirm={disconnect}
      />
    </>
  )
}

/**
 * The folder's leftovers, under the list: files the watcher could not read,
 * offered again or skipped for good, and the files skipped before, which can
 * be brought back.
 */
export function DriveFileLists({
  failed,
  skipped,
}: {
  failed: DriveFileRow[]
  skipped: DriveFolderPayload["skipped"]
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  // The button whose write is in flight, as `<fileId>:<verb>`: it spins until
  // the refreshed lists show where the file went, and its neighbour waits.
  const [busy, setBusy] = React.useState<string | null>(null)

  const run = async (
    key: string,
    write: () => Promise<{ ok: true } | { error: string }>
  ) => {
    setBusy(key)
    try {
      const result = await write()
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }
  /** Back in line; the next poll reads it again. */
  const retry = (driveFileId: string) =>
    run(`${driveFileId}:retry`, () => retryDriveFile(driveFileId))
  const skipFailed = (file: DriveFileRow) =>
    run(`${file.driveFileId}:skip`, () =>
      skipDriveFiles({
        files: [
          {
            driveFileId: file.driveFileId,
            fileName: file.name,
            reason: "",
            part: null,
          },
        ],
      })
    )
  const unskip = (driveFileId: string) =>
    run(`${driveFileId}:unskip`, () => unskipDriveFile(driveFileId))

  if (failed.length === 0 && skipped.length === 0) return null

  return (
    <div className="mt-2.5 rounded-xl border border-border bg-background px-4 py-3">
      {failed.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Couldn&apos;t read
          </p>
          <ul className="mt-1.5">
            {failed.map((file) => (
              <li
                key={file.driveFileId}
                className="flex items-center gap-2 border-b border-muted py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">
                  {file.name}
                </span>
                <span className="truncate text-xs text-faint">
                  {file.reason}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  pending={busy === `${file.driveFileId}:retry`}
                  disabled={busy === `${file.driveFileId}:skip`}
                  onClick={() => void retry(file.driveFileId)}
                >
                  Retry
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  pending={busy === `${file.driveFileId}:skip`}
                  disabled={busy === `${file.driveFileId}:retry`}
                  onClick={() => void skipFailed(file)}
                >
                  Skip permanently
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div className={failed.length > 0 ? "mt-4" : undefined}>
          <p className="text-xs font-medium text-muted-foreground">
            Skipped files
          </p>
          <ul className="mt-1.5">
            {skipped.map((file) => (
              <li
                key={file.driveFileId}
                className="flex items-center gap-2 border-b border-muted py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">
                  {file.fileName || file.driveFileId}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  pending={busy === `${file.driveFileId}:unskip`}
                  onClick={() => void unskip(file.driveFileId)}
                >
                  Unskip
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
