"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Puzzle } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"

import { InvoiceMonthFilter } from "@/components/invoices/month-filter"
import { InvoicesTable } from "@/components/invoices/invoices-table"
import { GuardedLink } from "@/components/navigation-blocker"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { Button, buttonVariants } from "@/components/ui/button"
import { MenuLinkItem } from "@/components/ui/menu"
import { EmptyState, Page, PageHeader, PageTitle } from "@/components/ui/page"
import { SectionTab, SectionTabs } from "@/components/ui/section-tabs"
import type { InvoiceRow, InvoicesOverview } from "@/lib/backend/types"
import { cn } from "@/lib/utils"
import { useBrowseUrl } from "@/hooks/use-browse-url"
import { useIngredientOptions } from "@/hooks/use-ingredient-options"
import type { GoogleDriveConfig } from "@/lib/google-drive"
import { useDialogTarget } from "@/components/ui/dialog"
import { formatCalendarDayMonth } from "@/lib/datetime"

const ImportInvoicesDialog = dynamic(() =>
  import("@/components/invoices/import-invoices-dialog").then(
    (module) => module.ImportInvoicesDialog
  )
)

/** Files the parser accepts, kept in step with the import dialog's own cap. */
const DROP_HINT = "PDF, up to 5 MB each"

function dragCarriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files")
}

export function InvoicesScreen({
  overview,
  query,
  tab,
  byok,
  driveConfig,
  driveConnectHref,
}: {
  overview: InvoicesOverview
  /** What `?q=` asked for; the server searched every month for it. */
  query: string
  /** The tab in the URL: the attention list, or the month. */
  tab: "attention" | null
  /** The deployment reads with the workspace's own Anthropic key rather than
   * Forkluck's AI, so the key is worth offering here. */
  byok: boolean
  driveConfig: GoogleDriveConfig | null
  /** Where to connect a folder, when this server can read Drive but the
   * workspace has not connected one yet. */
  driveConnectHref: string | null
}) {
  const [importOpen, setImportOpen] = React.useState(false)
  const importShown = useDialogTarget(importOpen ? true : null)
  const [importFiles, setImportFiles] = React.useState<File[] | null>(null)
  // Opened on the inbox — the receipts the Drive watcher has already read —
  // rather than on an empty drop zone.
  const [importInbox, setImportInbox] = React.useState(false)
  const {
    options: ingredientOptions,
    status: ingredientOptionsStatus,
    load: loadOptions,
    add: addIngredientOption,
  } = useIngredientOptions()
  const [dragging, setDragging] = React.useState(false)
  // Drag events fire for every child the cursor crosses, so leaves are counted
  // against enters rather than trusted on their own.
  const dragDepth = React.useRef(0)

  const browse = useBrowseUrl({ query })
  // A month change is a navigation too; the rows wash out the same way a
  // search does until the new month arrives.
  const [monthPending, setMonthPending] = React.useState(false)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const listHref = search ? `${pathname}?${search}` : pathname

  const invoices = overview.invoices
  // "No invoices yet" is the brand-new-account state, not "this month is
  // empty" — an account with history keeps its toolbar and its month list.
  const hasInvoices = invoices.length > 0 || overview.months.length > 0
  // The attention tab and a search both answer across every month, so the
  // month picker and the month's spend belong to neither.
  const monthView = tab === null && query.trim() === ""
  const emptyMessage =
    invoices.length > 0
      ? "No invoices match those filters."
      : query.trim() !== ""
        ? "No invoices match that search."
        : tab === "attention"
          ? "Nothing needs attention."
          : "No invoices in this month."

  const segmentFilters = React.useMemo(() => {
    const suppliers = [
      ...new Set(invoices.map((row) => row.supplierName)),
    ].sort((left, right) => left.localeCompare(right))
    return [
      {
        label: "Supplier",
        options: suppliers.map((name) => ({ value: name, label: name })),
        getValue: (row: InvoiceRow) => row.supplierName,
        contentClassName: "w-[190px]",
      },
    ]
  }, [invoices])

  const openImport = (files: File[] | null, options?: { inbox?: boolean }) => {
    setImportFiles(files)
    setImportInbox(options?.inbox ?? false)
    setImportOpen(true)
    void loadOptions()
  }

  // Reaching for the button, or dragging a file over the page, is the cue: the
  // dialog's code and the pantry list are usually in by the time the drop or
  // click lands, so the dialog opens whole instead of behind a spinner.
  const prefetchImport = () => {
    if (ingredientOptionsStatus === "idle") void loadOptions()
    void import("@/components/invoices/import-invoices-dialog")
  }

  // The receipts the Drive watcher has read and nobody has confirmed: the
  // work waiting here, so it sits with the other ways in. Absent at zero.
  const reviewButton =
    overview.driveReadyCount > 0 ? (
      <Button
        variant="outline"
        onPointerEnter={prefetchImport}
        onFocus={prefetchImport}
        onClick={() => openImport(null, { inbox: true })}
      >
        {`Review (${overview.driveReadyCount})`}
      </Button>
    ) : null

  const endDrag = () => {
    dragDepth.current = 0
    setDragging(false)
  }

  return (
    <Page
      onDragEnter={(event) => {
        if (!dragCarriesFiles(event)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
        prefetchImport()
      }}
      onDragOver={(event) => {
        if (!dragCarriesFiles(event)) return
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!dragCarriesFiles(event)) return
        dragDepth.current -= 1
        if (dragDepth.current <= 0) endDrag()
      }}
      onDrop={(event) => {
        if (!dragCarriesFiles(event)) return
        event.preventDefault()
        endDrag()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) openImport(files)
      }}
    >
      <PageHeader>
        <PageTitle>Invoices</PageTitle>
      </PageHeader>

      {!byok && overview.aiUsage?.maxPages !== null && overview.aiUsage && (
        <p className="text-xs text-muted-foreground" role="status">
          {overview.aiUsage.usedPages} of {overview.aiUsage.maxPages} AI pages
          used. Resets {formatCalendarDayMonth(overview.aiUsage.resetsOn)}.
          {overview.aiUsage.exhausted &&
            " You can still enter invoices manually."}
          {overview.aiUsage.maxPages === 10 && (
            <>
              {" "}
              <GuardedLink
                href="/subscribe"
                className="underline underline-offset-4"
              >
                Upgrade
              </GuardedLink>
            </>
          )}
        </p>
      )}

      {hasInvoices ? (
        <>
          <SectionTabs>
            <SectionTab href="/invoices" active={tab === null}>
              All
            </SectionTab>
            <SectionTab
              href="/invoices?tab=attention"
              active={tab === "attention"}
            >
              {`Needs attention (${overview.needsReviewCount})`}
            </SectionTab>
          </SectionTabs>
          <InvoicesTable
            // Supplier choices are scoped to what is on screen. Remounting
            // clears an uncontrolled supplier selection the next list cannot
            // show.
            key={`${overview.month}:${tab ?? ""}`}
            invoices={invoices}
            listHref={listHref}
            segmentFilters={segmentFilters}
            remote={{
              searchValue: browse.searchValue,
              onSearchValueChange: browse.onSearchValueChange,
              searchPending: browse.isPending || monthPending,
              // Django orders the page and takes no sort parameter; with no
              // sortColumns named, the columns sort the page on the client.
              order: "",
              sortColumns: {},
              onOrderChange: () => {},
            }}
            toolbarLeading={
              <>
                {/* Not in the handoff, which shows a single period of demo
                    data. The month view is scoped to one month, so without
                    this the older months would have no way back. */}
                {monthView && overview.months.length > 1 ? (
                  <InvoiceMonthFilter
                    month={overview.month}
                    months={overview.months}
                    onPendingChange={setMonthPending}
                  />
                ) : null}
              </>
            }
            primary={
              <>
                {reviewButton}
                <Button
                  variant="outline"
                  onPointerEnter={prefetchImport}
                  onFocus={prefetchImport}
                  onClick={() => openImport(null)}
                >
                  Upload invoice
                </Button>
                <GuardedLink
                  href="/invoices/new"
                  className={cn(buttonVariants())}
                >
                  New invoice
                </GuardedLink>
              </>
            }
            actions={
              overview.connectors.configured ? (
                <ActionsMenu>
                  <MenuLinkItem href="/integrations/suppliers/connections">
                    <Puzzle strokeWidth={1.8} aria-hidden="true" />
                    Integrations
                  </MenuLinkItem>
                </ActionsMenu>
              ) : null
            }
            dragging={dragging}
            dropHint={DROP_HINT}
            emptyMessage={emptyMessage}
          />
        </>
      ) : (
        <>
          <EmptyState
            title="No invoices yet"
            description="Import supplier invoice PDFs from Google Drive or your computer. Ingredient lines keep your supplier prices current, and every invoice lands in your monthly spend by category and supplier."
          >
            <GuardedLink href="/invoices/new" className={cn(buttonVariants())}>
              New invoice
            </GuardedLink>
            <Button
              variant="outline"
              onPointerEnter={prefetchImport}
              onFocus={prefetchImport}
              onClick={() => openImport(null)}
            >
              Upload invoice
            </Button>
            {reviewButton}
          </EmptyState>
        </>
      )}

      {importShown ? (
        <ImportInvoicesDialog
          open={importOpen}
          onOpenChange={(open) => {
            setImportOpen(open)
            if (!open) setImportFiles(null)
          }}
          initialFiles={importFiles}
          inbox={importInbox}
          config={driveConfig}
          driveConnectHref={driveConnectHref}
          ingredients={ingredientOptions}
          onIngredientCreated={addIngredientOption}
          // The list is asked for as the dialog opens, so "idle" only lasts
          // until that request is on its way.
          ingredientsStatus={
            ingredientOptionsStatus === "idle"
              ? "loading"
              : ingredientOptionsStatus
          }
          onRetryIngredients={() => void loadOptions()}
          byok={byok}
          aiKeyConfigured={overview.aiKey.configured}
          aiKeyHint={overview.aiKey.hint}
        />
      ) : null}
    </Page>
  )
}
