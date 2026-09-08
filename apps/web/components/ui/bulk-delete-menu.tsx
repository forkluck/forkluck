"use client"

import * as React from "react"
import { Ellipsis, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { useToast } from "@/components/ui/toast"
import { useRefresh } from "@/hooks/use-refresh"
import { toSaveFailure } from "@/lib/save-failure"

/**
 * The "…" menu in every table's selection bar. Delete sits behind a
 * confirmation dialog and reports in the one order every delete keeps: the
 * rows change, the confirmation leaves, a toast says how many went.
 * `children` are extra items a screen adds above Delete.
 */
export function BulkDeleteMenu({
  count,
  noun,
  plural = `${noun}s`,
  description,
  onDelete,
  onDeleted,
  refreshAfterDelete = true,
  children,
}: {
  count: number
  /** Singular item name, e.g. "recipe" or "menu item". */
  noun: string
  /** Only where adding an s is wrong ("supply"). */
  plural?: string
  /** One sentence under the confirm title describing the consequence. */
  description: string
  /**
   * Deletes the selection, in one request. False keeps the confirmation and
   * selection open after a failed batch.
   */
  onDelete: () => Promise<void | boolean>
  /** Once the rows are gone: the moment to clear the selection. */
  onDeleted?: () => void
  /**
   * False when the action revalidates the route it was called from: its
   * response already carries the fresh rows.
   */
  refreshAfterDelete?: boolean
  children?: React.ReactNode
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  // A transition, so "Deleting…" holds until the rows the action answered
  // with have committed, not just until it answered. After an await React
  // has lost the transition's scope, so the updates that should land with
  // those rows are started again inside it.
  const [pending, startTransition] = React.useTransition()

  const counted = count === 1 ? noun : plural

  const confirmDelete = () =>
    startTransition(async () => {
      try {
        if ((await onDelete()) === false) return
      } catch (cause) {
        // A batch that threw part-way has no other way to say so.
        toast.add({ title: toSaveFailure(cause).message, type: "error" })
        return
      }
      const done = () => {
        setConfirmOpen(false)
        onDeleted?.()
        toast.add({ title: `Deleted ${count} ${counted}` })
      }
      // Not awaited: inside a transition the refresh would wait on itself.
      if (refreshAfterDelete) void refresh().then(done)
      else startTransition(done)
    })

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Selection actions"
            />
          }
        >
          {/* Filled dots, not rings: r=1 plus a 1.2 stroke lands on the 1.6
              radius the design draws. */}
          <Ellipsis
            className="size-[18px] fill-current"
            strokeWidth={1.2}
            aria-hidden="true"
          />
        </MenuTrigger>
        <MenuContent align="start" className="w-[196px]">
          {children}
          <MenuItem
            onClick={() => setConfirmOpen(true)}
            className="text-destructive data-highlighted:text-destructive"
          >
            <Trash2
              className="text-current"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Delete {counted}
          </MenuItem>
        </MenuContent>
      </Menu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${count} ${counted}?`}
        description={description}
        confirmLabel={pending ? "Deleting…" : `Delete ${counted}`}
        pending={pending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
