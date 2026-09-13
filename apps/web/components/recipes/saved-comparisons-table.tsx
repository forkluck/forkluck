"use client"

import * as React from "react"
import { useToast } from "@/components/ui/toast"
import { Trash2 } from "lucide-react"

import {
  GuardedLink,
  useGuardedNavigate,
} from "@/components/navigation-blocker"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DataTable, dataTableColumns } from "@/components/ui/data-table"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { formatDayMonth } from "@/lib/datetime"
import type { SavedComparisonRow } from "@/lib/backend/types"
import { COMPARE_PATH } from "@/lib/recipe/compare"
import { deleteComparison } from "@/app/(app)/recipes/compare/actions"

const helper = dataTableColumns<SavedComparisonRow>()

function Cell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-base whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

export const savedComparisonHref = (row: { publicId: string }) =>
  `${COMPARE_PATH}?c=${encodeURIComponent(row.publicId)}`

/** The comparisons this account kept, newest first; open one or delete it. */
export function SavedComparisonsTable({
  rows,
}: {
  rows: SavedComparisonRow[]
}) {
  const { timezone } = useBusinessSettings()
  const toast = useToast()
  const { go } = useGuardedNavigate()
  const [deleteTarget, setDeleteTarget] =
    React.useState<SavedComparisonRow | null>(null)
  // The row stays until the server has answered; after an await React has
  // lost the transition, so the updates start it again.
  const [deletePending, startDelete] = React.useTransition()
  const [hiddenRowIds, setHiddenRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const data = React.useMemo(
    () => rows.filter((row) => !hiddenRowIds.has(row.id)),
    [hiddenRowIds, rows]
  )

  const confirmDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    startDelete(async () => {
      try {
        const result = await deleteComparison(target.id)
        if ("error" in result) throw new Error(result.error)
      } catch (cause) {
        toast.add({
          title:
            cause instanceof Error
              ? cause.message
              : "Couldn’t delete the comparison.",
          type: "error",
        })
        return
      }
      startDelete(() => {
        setHiddenRowIds((current) => new Set(current).add(target.id))
        setDeleteTarget(null)
        toast.add({ title: `Deleted ${target.title}` })
      })
    })
  }

  const rowActions = React.useCallback(
    (row: SavedComparisonRow) => (
      <RowActionsMenu label={`Actions for ${row.title}`}>
        <MenuItem
          onClick={() => setDeleteTarget(row)}
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
      helper.accessor((row) => row.title, {
        id: "title",
        header: "Comparison",
        enableHiding: false,
        meta: { className: "max-w-0", minWidth: 220 },
        cell: ({ row }) => (
          <GuardedLink
            href={savedComparisonHref(row.original)}
            className="block min-w-0 truncate text-foreground"
          >
            {row.original.title}
          </GuardedLink>
        ),
      }),
      helper.accessor((row) => row.columnTitles.join(", "), {
        id: "recipes",
        header: "Recipes",
        meta: { className: "w-[44%] max-w-0", minWidth: 200 },
        cell: ({ getValue }) => (
          <span className="block min-w-0 truncate text-base text-muted-foreground">
            {getValue() as string}
          </span>
        ),
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
        columnsMenu={{
          storageKey: "saved-comparisons",
          headerColumnId: "actions",
        }}
        emptyMessage="No saved comparisons match your search."
        onRowClick={(row) => go(savedComparisonHref(row))}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteTarget(null)
        }}
        title="Delete this comparison?"
        description={`${deleteTarget?.title ?? "This comparison"} is removed. The recipes are untouched.`}
        confirmLabel={deletePending ? "Deleting…" : "Delete comparison"}
        pending={deletePending}
        onConfirm={confirmDelete}
      />
    </>
  )
}
