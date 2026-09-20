"use client"

import * as React from "react"

import { revokeDevice } from "@/app/(app)/profile/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import type { DeviceRow } from "@/lib/backend/types"
import { relativeAgo } from "@/lib/connector-status"
import { formatFullDate } from "@/lib/datetime"

/**
 * The phones signed in through the mobile API, each with the one thing the
 * owner can do to it from here: sign it out. The row stays, spinning, until
 * the backend answers; the re-rendered page is what removes it.
 */
export function DevicesList({ devices }: { devices: DeviceRow[] }) {
  const toast = useToast()
  const { timezone } = useBusinessSettings()
  const [now] = React.useState(() => Date.now())
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [isPending, startTransition] = React.useTransition()

  function revoke(device: DeviceRow) {
    setPendingId(device.id)
    startTransition(async () => {
      const result = await revokeDevice(device.id)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      toast.add({ title: `Signed out ${device.name || "that phone"}` })
    })
  }

  if (devices.length === 0) {
    return <p className="text-md text-muted-foreground">No phones signed in.</p>
  }

  return (
    <ul className="max-w-[640px] overflow-hidden rounded-xl border border-border">
      {devices.map((device) => (
        <li
          key={device.id}
          className="flex items-center gap-4 border-b border-muted px-4 py-3.5 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="text-md">{device.name || "Phone"}</div>
            <div className="mt-[3px] text-md text-muted-foreground">
              Added {formatFullDate(device.createdAt, timezone)}
              {device.lastUsedAt
                ? ` · last used ${relativeAgo(device.lastUsedAt.toISOString(), now)}`
                : ""}
            </div>
          </div>
          <Button
            variant="outline"
            pending={isPending && pendingId === device.id}
            disabled={isPending}
            onClick={() => revoke(device)}
          >
            Sign out
          </Button>
        </li>
      ))}
    </ul>
  )
}
