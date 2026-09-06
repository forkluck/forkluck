"use client"

import * as React from "react"
import { useToast } from "@/components/ui/toast"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"

import {
  GuardedLink,
  useNavigationBlocker,
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
  const router = useRouter()
  const toast = useToast()
  const { allowNavigation, confirmNavigation } = useNavigationBlocker()
  const [deleteTarget, setDeleteTarget] = React.useState<MenuRow | null>(null)
  const [deletePending, setDeletePending] = React.useState(false)
  const [hiddenRowIds, setHiddenRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const data = React.useMemo(
    () => rows.filter((row) => !hiddenRowIds.has(row.id)),
    [hiddenRowIds, rows]
  )

  const go = React.useCallback(
    async (href: string) => {
      if (!(await confirmNavigation())) return
      allowNavigation()
      router.push(href)
    },
    [allowNavigation, confirmNavigation, router]
  )

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeletePending(true)
    setDeleteTarget(null)
    setHiddenRowIds((current) => new Set(current).add(target.id))
    try {
      const result = await deleteMenu(target.id)
      if ("error" in result) throw new Error(result.error)
      toast.add({ title: `Deleted ${target.name}` })
    } catch (cause) {
      setHiddenRowIds((current) => {
        const next = new Set(current)
        next.delete(target.id)
        return next
      })
      toast.add({
        title:
          cause instanceof Error ? cause.message : "Couldn’t delete the menu.",
        type: "error",
      })
    } finally {
      setDeletePending(false)
    }
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
          if (!open) setDeleteTarget(null)
        }}
        title="Delete this menu?"
        description={`${deleteTarget?.name ?? "This menu"} is removed, along with its worksheet rows. Recipes and products are untouched.`}
        confirmLabel="Delete menu"
        pending={deletePending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
