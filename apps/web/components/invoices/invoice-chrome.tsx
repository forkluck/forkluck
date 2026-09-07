"use client"

import * as React from "react"
import { ExternalLink, Trash2 } from "lucide-react"

import { deleteInvoice } from "@/app/(app)/invoices/actions"
import { useGuardedNavigate } from "@/components/navigation-blocker"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { MenuItem, MenuLinkItem } from "@/components/ui/menu"
import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { SaveButton } from "@/components/ui/save-button"
import { SaveStatus, type SaveStatusState } from "@/components/ui/save-status"
import { useToast } from "@/components/ui/toast"
import { useEditChrome } from "@/hooks/use-edit-chrome"

type InvoiceEditValue = {
  /** The editor puts its save here; the header's Save button calls it. */
  saveRef: React.RefObject<(() => Promise<unknown>) | null>
  dirty: boolean
  setDirty: (dirty: boolean) => void
  saveState: SaveStatusState
  setSaveState: (state: SaveStatusState) => void
}

const InvoiceEditContext = React.createContext<InvoiceEditValue | null>(null)

export function useInvoiceEdit() {
  const value = React.useContext(InvoiceEditContext)
  if (!value) {
    throw new Error("useInvoiceEdit must be used inside InvoiceChrome")
  }
  return value
}

/** The header every invoice screen shares. */
export function InvoiceChrome({
  title,
  id,
  publicId,
  driveWebViewLink,
  listHref = "/invoices",
  children,
}: {
  title: string
  /** Absent on the create screen, which has nothing to delete yet. */
  id?: string
  publicId?: string
  driveWebViewLink?: string
  /** The list state this invoice was opened from. */
  listHref?: string
  children: React.ReactNode
}) {
  const { go } = useGuardedNavigate()
  const toast = useToast()
  const {
    dirty,
    setDirty,
    saveState,
    setSaveState,
    saveRef,
    savePending,
    saveLabel,
    save,
  } = useEditChrome()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  const value = React.useMemo(
    () => ({ saveRef, dirty, setDirty, saveState, setSaveState }),
    [dirty, saveRef, saveState, setDirty, setSaveState]
  )

  const remove = async () => {
    if (!id) return
    setPending(true)
    const result = await deleteInvoice(id)
    setPending(false)
    if ("error" in result) {
      toast.add({ title: result.error, type: "error" })
      return
    }
    setConfirmDelete(false)
    setDirty(false)
    void go(listHref, { force: true })
  }

  return (
    <InvoiceEditContext.Provider value={value}>
      <PageHeader className="flex-wrap items-center">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href={listHref}>Invoices</PageParent>
          </PageParents>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <PageTitle>
              <span className="truncate">{title}</span>
            </PageTitle>
            <SaveStatus
              state={saveState}
              dirty={dirty}
              saved={Boolean(publicId)}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ActionsMenu disabled={!id}>
            {driveWebViewLink ? (
              <MenuLinkItem
                href={driveWebViewLink}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink strokeWidth={1.8} aria-hidden="true" />
                Open in Drive
              </MenuLinkItem>
            ) : null}
            <MenuItem
              disabled={!id}
              onClick={() => setConfirmDelete(true)}
              className="text-destructive data-highlighted:text-destructive"
            >
              <Trash2
                className="text-current"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Delete invoice
            </MenuItem>
          </ActionsMenu>
          <SaveButton pending={savePending} label={saveLabel} onSave={save} />
        </div>
      </PageHeader>

      {children}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this invoice?"
        description="The invoice is removed. Ingredient prices it set stay as they are."
        confirmLabel={pending ? "Deleting…" : "Delete invoice"}
        pending={pending}
        onConfirm={remove}
      />
    </InvoiceEditContext.Provider>
  )
}
