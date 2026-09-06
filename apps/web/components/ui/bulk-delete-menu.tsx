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
 * confirmation dialog; deletion happens one row at a time via the passed
 * callback — fine at the sizes a kitchen selects. `children` are extra
 * items a screen adds above Delete.
 */
export function BulkDeleteMenu({
  count,
  noun,
  description,
  onDelete,
  refreshAfterDelete = true,
  children,
}: {
  count: number
  /** Singular item name, e.g. "recipe" or "menu item". */
  noun: string
  /** One sentence under the confirm title describing the consequence. */
  description: string
  /** False keeps the confirmation and selection open after a failed batch. */
  onDelete: () => Promise<void | boolean>
  refreshAfterDelete?: boolean
  children?: React.ReactNode
}) {
  const { refresh } = useRefresh()
  const toast = useToast()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  const plural = count === 1 ? noun : `${noun}s`

  const confirmDelete = async () => {
    setPending(true)
    try {
      const deleted = await onDelete()
      if (deleted === false) return
      // "Deleting…" holds until the refreshed rows show them gone; only then
      // does the confirmation leave.
      if (refreshAfterDelete) await refresh()
      setConfirmOpen(false)
    } catch (cause) {
      // A batch that threw part-way has no other way to say so.
      toast.add({ title: toSaveFailure(cause).message, type: "error" })
    } finally {
      setPending(false)
    }
  }

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
            Delete {plural}
          </MenuItem>
        </MenuContent>
      </Menu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${count} ${plural}?`}
        description={description}
        confirmLabel={pending ? "Deleting…" : `Delete ${plural}`}
        pending={pending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
