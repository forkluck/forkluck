"use client"

import * as React from "react"
import { useToast } from "@/components/ui/toast"
import { Trash2 } from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { buttonVariants } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DataTable, dataTableColumns } from "@/components/ui/data-table"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { formatDateRangeLabel } from "@/lib/date-range-label"
import { formatDayMonth } from "@/lib/datetime"
import type { MenuRow } from "@/lib/backend/types"
import { cn } from "@/lib/utils"
import { deleteMenu } from "@/app/(app)/menu/actions"

const helper = dataTableColumns<MenuRow>()

/** Secondary cell: 13.5px `--muted-foreground`, one step under the name. */
function Cell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-base whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

const menuHref = (menu: MenuRow) => `/menu/${menu.publicId || menu.id}`

const periodLabel = (menu: MenuRow) =>
  menu.periodStart && menu.periodEnd
    ? formatDateRangeLabel(menu.periodStart, menu.periodEnd)
    : "All time"

export function MenusTable({ rows }: { rows: MenuRow[] }) {
  const { timezone } = useBusinessSettings()
  const toast = useToast()
  const { go } = useGuardedNavigate()
  const [deleteTarget, setDeleteTarget] = React.useState<MenuRow | null>(null)
  // A transition: "Deleting…" holds until the rows the action answered with
  // have committed, and the confirmation leaves with them. After an await
  // React has lost the transition's scope, so those updates start it again.
  const [deletePending, startDelete] = React.useTransition()
  const [hiddenRowIds, setHiddenRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const data = React.useMemo(
    () => rows.filter((row) => !hiddenRowIds.has(row.id)),
    [hiddenRowIds, rows]
  )

  // Nothing on screen changes until the server has answered: the row goes,
  // then the confirmation, then the toast.
  const confirmDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    startDelete(async () => {
      try {
        const result = await deleteMenu(target.id)
        if ("error" in result) throw new Error(result.error)
      } catch (cause) {
        toast.add({
          title:
            cause instanceof Error
              ? cause.message
              : "Couldn’t delete the menu.",
          type: "error",
        })
        return
      }
      startDelete(() => {
        setHiddenRowIds((current) => new Set(current).add(target.id))
        setDeleteTarget(null)
        toast.add({ title: `Deleted ${target.name}` })
      })
    })
  }

  const rowActions = React.useCallback(
    (menu: MenuRow) => (
      <RowActionsMenu label={`Actions for ${menu.name}`}>
        <MenuItem
          onClick={() => setDeleteTarget(menu)}
          className="text-destructive data-highlighted:text-destructive"
        >
          <Trash2 strokeWidth={1.8} aria-hidden="true" />
          Delete
        </MenuItem>
      </RowActionsMenu>
    ),
    []
  )

  const columns = React.useMemo(
    () => [
      helper.accessor((row) => row.name, {
        id: "menu",
        header: "Menu",
        // The row's identity — hiding it would leave nameless rows.
        enableHiding: false,
        meta: { className: "max-w-0", minWidth: 260 },
        cell: ({ row }) => (
          <GuardedLink
            href={menuHref(row.original)}
            className="block min-w-0 truncate text-foreground"
          >
            {row.original.name}
          </GuardedLink>
        ),
      }),
      helper.accessor((row) => periodLabel(row), {
        id: "period",
        header: "Period",
        meta: { className: "w-[26%]", minWidth: 160 },
        cell: ({ getValue }) => <Cell>{getValue() as string}</Cell>,
      }),
      helper.accessor((row) => row.itemCount, {
        id: "items",
        header: "Items",
        meta: { align: "right", className: "w-[11%]", minWidth: 90 },
        cell: ({ row }) => <Cell>{row.original.itemCount}</Cell>,
      }),
      helper.accessor((row) => row.updatedAt.getTime(), {
        id: "updated",
        header: "Last updated",
        meta: { align: "right", className: "w-[14%]", minWidth: 120 },
        cell: ({ row }) => (
          <Cell>{formatDayMonth(row.original.updatedAt, timezone)}</Cell>
        ),
      }),
      helper.display({
        id: "actions",
        enableHiding: false,
        meta: { align: "right", className: "w-11", minWidth: 44 },
        cell: ({ row }) => rowActions(row.original),
      }),
    ],
    [rowActions, timezone]
  )

  return (
    <>
      <DataTable
        columns={columns}
        data={data}
        getRowId={(row) => row.id}
        tableClassName="table-fixed"
        columnsMenu={{ storageKey: "menus", headerColumnId: "actions" }}
        emptyMessage="No menus match your search."
        toolbarExtra={
          <GuardedLink href="/menu/new" className={cn(buttonVariants())}>
            New menu
          </GuardedLink>
        }
        onRowClick={(row) => go(menuHref(row))}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteTarget(null)
        }}
        title="Delete this menu?"
        description={`${deleteTarget?.name ?? "This menu"} is removed, along with its worksheet rows. Recipes and products are untouched.`}
        confirmLabel={deletePending ? "Deleting…" : "Delete menu"}
        pending={deletePending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
