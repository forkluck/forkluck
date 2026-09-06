"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CloudUpload, FileText, Trash2 } from "lucide-react"

import { deleteInvoice } from "@/app/(app)/invoices/actions"
import { issueText } from "@/components/invoices/invoice-issue"
import { AlertFlag } from "@/components/menu/product-cells"
import { GuardedLink } from "@/components/navigation-blocker"
import { Badge } from "@/components/ui/badge"
import { BulkDeleteMenu } from "@/components/ui/bulk-delete-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DataTable,
  dataTableColumns,
  type DataTableRemote,
  type SegmentFilter,
} from "@/components/ui/data-table"
import { MenuItem, MenuLinkItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { useToast } from "@/components/ui/toast"
import type { InvoiceRow } from "@/lib/backend/types"
import { invoiceDetailHref } from "@/lib/invoice-navigation"
import { formatCents } from "@/lib/money"
import { formatCalendarDayMonth } from "@/lib/datetime"
import { deleteEach } from "@/lib/delete-each"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"

const helper = dataTableColumns<InvoiceRow>()

/** The connector that brought the invoice in, when it was not a file. */
function SourceBadge() {
  return <Badge size="row">Supplier import</Badge>
}

function invoiceLabel(row: InvoiceRow): string {
  return row.invoiceNumber || row.fileName
}

/**
 * Invoices table. Columns are the handoff's grid, expressed as the table's
 * own widths: a 30px checkbox track, a fluid Supplier column, a 56px flag
 * lane, then Invoice 132, Date 108, Lines 92, Total 104 and a 44px menu lane.
 *
 * The tab pills above the table are the status, so what is wrong with a row
 * rides beside its supplier name as a marker instead of repeating the tab.
 */
export function InvoicesTable({
  invoices,
  emptyMessage,
  segmentFilters,
  toolbarLeading,
  primary,
  actions,
  dragging = false,
  dropHint,
  remote,
  listHref = "/invoices",
}: {
  invoices: InvoiceRow[]
  emptyMessage: string
  segmentFilters?: Array<SegmentFilter<InvoiceRow>>
  /** The month pill, which navigates rather than filtering rows. */
  toolbarLeading?: React.ReactNode
  /** The black New invoice menu, drawn by the screen that owns the import dialog. */
  primary?: React.ReactNode
  /** The grey Actions pill, drawn by the screen that owns what it opens. */
  actions?: React.ReactNode
  /** True while files are over the page: the table gives way to a drop box. */
  dragging?: boolean
  dropHint?: string
  /** Search lives in `?q=`, which the server answers across every month. */
  remote?: DataTableRemote
  /** The current list URL, carried through the detail screen's way back. */
  listHref?: string
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const toast = useToast()
  const [deleting, setDeleting] = React.useState<InvoiceRow | null>(null)
  const [pending, setPending] = React.useState(false)

  const removeOne = async (row: InvoiceRow) => {
    setPending(true)
    try {
      const result = await deleteInvoice(row.id)
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      // The dialog leaves once the row has.
      await refresh()
      setDeleting(null)
      toast.add({ title: "Deleted invoice" })
    } finally {
      setPending(false)
    }
  }

  const columns = React.useMemo(
    () => [
      helper.accessor((row) => row.supplierName, {
        id: "supplier",
        header: "Supplier",
        // No width of its own: under table-fixed the fluid column is the one
        // that absorbs what the fixed ones leave, never the checkbox track.
        meta: { className: "max-w-0" },
        // A link, not bare text: Next prefetches a route whose link is on
        // screen, so the row click that follows lands on a warm route instead
        // of waiting a round trip before the page can even start loading.
        cell: (info) => (
          <GuardedLink
            href={invoiceDetailHref(info.row.original.publicId, listHref)}
            className="block truncate text-md text-foreground outline-none focus-visible:underline"
          >
            {info.row.original.supplierName}
          </GuardedLink>
        ),
      }),
      // Its own slim column, as on Recipes, so the flags line up instead of
      // trailing names of every length. Empty for a sound row: the tab pills
      // above are the status, the flag names what is actually wrong.
      helper.display({
        id: "alerts",
        enableHiding: false,
        enableSorting: false,
        // 56px, not 44: the flag's chevron needs room to the right, or it sits
        // glued to the next column's text.
        meta: { align: "center", className: "w-14", minWidth: 56 },
        cell: ({ row }) => {
          const text = issueText(row.original, row.original.currencyCode)
          return text ? <AlertFlag label={text} width={260} /> : null
        },
      }),
      helper.accessor((row) => invoiceLabel(row), {
        id: "number",
        header: "Invoice",
        meta: { className: "w-[17%]" },
        // Cap the text itself so a long file-name fallback still truncates
        // cleanly inside the proportional column.
        cell: (info) => (
          <span className="flex items-center gap-1.5">
            <span className="tabular block max-w-[132px] truncate text-base text-muted-foreground">
              {invoiceLabel(info.row.original)}
            </span>
            {info.row.original.source === "connector" ? <SourceBadge /> : null}
          </span>
        ),
      }),
      helper.accessor((row) => row.invoiceDate ?? "", {
        id: "date",
        header: "Date",
        meta: { className: "w-[12%]", align: "right" },
        cell: (info) => (
          <span className="text-base whitespace-nowrap text-muted-foreground">
            {formatCalendarDayMonth(info.row.original.invoiceDate)}
          </span>
        ),
      }),
      helper.accessor((row) => row.lineCount, {
        id: "lines",
        header: "Lines",
        meta: { className: "w-[9%]", align: "right" },
        cell: (info) => (
          <span className="text-base text-muted-foreground">
            {info.row.original.lineCount}
          </span>
        ),
      }),
      helper.accessor((row) => row.totalCents, {
        id: "total",
        header: "Total",
        meta: { className: "w-[11%]", align: "right" },
        cell: (info) => (
          <span
            className={cn(
              "text-base whitespace-nowrap",
              info.row.original.totalCents < 0
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {formatCents(
              info.row.original.totalCents,
              info.row.original.currencyCode
            )}
          </span>
        ),
      }),
      helper.display({
        id: "actions",
        enableSorting: false,
        meta: { className: "w-[4%] min-w-11" },
        cell: (info) => {
          const row = info.row.original
          return (
            <span className="flex justify-end">
              <RowActionsMenu
                label={`Actions for ${row.supplierName} ${invoiceLabel(row)}`}
              >
                <MenuLinkItem href={invoiceDetailHref(row.publicId, listHref)}>
                  <FileText strokeWidth={1.8} aria-hidden="true" />
                  Open
                </MenuLinkItem>
                <MenuItem
                  className="text-destructive data-highlighted:text-destructive"
                  onClick={() => setDeleting(row)}
                >
                  <Trash2
                    className="text-current"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  Delete
                </MenuItem>
              </RowActionsMenu>
            </span>
          )
        },
      }),
    ],
    [listHref]
  )

  return (
    <>
      <DataTable
        columns={columns}
        data={invoices}
        getRowId={(row) => row.id}
        searchPlaceholder="Search"
        emptyMessage={emptyMessage}
        enableSelection
        tableClassName="table-fixed min-w-[820px]"
        segmentFilters={segmentFilters}
        remote={remote}
        toolbarLeading={toolbarLeading}
        toolbarExtra={
          <>
            {actions}
            {primary}
          </>
        }
        tableReplacement={
          dragging ? (
            // Never sized in viewport units: a fixed 420px box, so a drag
            // cannot stretch the page.
            <div className="flex h-[420px] flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-line-strong bg-fill-soft px-6 py-[30px] text-center">
              <CloudUpload
                className="size-5 text-muted-foreground"
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <p className="text-md leading-5 font-medium text-foreground">
                Drop files to upload
              </p>
              <p className="text-sm text-muted-foreground">{dropHint}</p>
            </div>
          ) : null
        }
        bulkActions={({ rows, clear }) => (
          <BulkDeleteMenu
            count={rows.length}
            noun="invoice"
            description="Ingredient prices they set stay as they are."
            onDelete={async () => {
              const result = await deleteEach(rows, (row) =>
                deleteInvoice(row.id)
              )
              if ("error" in result) {
                toast.add({ title: result.error, type: "error" })
                // Earlier rows may already be gone. Refresh their data while
                // keeping the confirmation open so the remaining selection
                // can be retried instead of reporting a completed batch.
                void refresh()
                return false
              }
              toast.add({
                title: `Deleted ${rows.length} invoice${rows.length === 1 ? "" : "s"}`,
              })
              clear()
              return true
            }}
          />
        )}
        onRowClick={(row) =>
          router.push(invoiceDetailHref(row.publicId, listHref))
        }
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
        title="Delete this invoice?"
        description={
          deleting
            ? `${deleting.supplierName} ${invoiceLabel(deleting)} is removed. Ingredient prices it set stay as they are.`
            : ""
        }
        confirmLabel={pending ? "Deleting…" : "Delete invoice"}
        pending={pending}
        onConfirm={() => (deleting ? removeOne(deleting) : undefined)}
      />
    </>
  )
}
