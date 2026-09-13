"use client"

import * as React from "react"

import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { SaveButton } from "@/components/ui/save-button"
import { SaveStatus, type SaveStatusState } from "@/components/ui/save-status"
import { useEditChrome } from "@/hooks/use-edit-chrome"
import { COMPARE_PATH } from "@/lib/recipe/compare"

type CompareEditValue = {
  /** The screen puts its save here; the header's Save button calls it. */
  saveRef: React.RefObject<(() => Promise<unknown>) | null>
  dirty: boolean
  setDirty: (dirty: boolean) => void
  saveState: SaveStatusState
  setSaveState: (state: SaveStatusState) => void
}

const CompareEditContext = React.createContext<CompareEditValue | null>(null)

export function useCompareEdit() {
  const value = React.useContext(CompareEditContext)
  if (!value) {
    throw new Error("useCompareEdit must be used inside CompareChrome")
  }
  return value
}

/** The header a comparison is edited under: the same one a menu has. */
export function CompareChrome({
  title,
  publicId,
  children,
}: {
  title: string
  /** Absent on the new screen. */
  publicId?: string
  children: React.ReactNode
}) {
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
  const value = React.useMemo(
    () => ({ saveRef, dirty, setDirty, saveState, setSaveState }),
    [dirty, saveRef, saveState, setDirty, setSaveState]
  )
  return (
    <CompareEditContext.Provider value={value}>
      <PageHeader className="flex-wrap items-center">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/recipes">Recipes</PageParent>
            <PageParent href={COMPARE_PATH}>Compare</PageParent>
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
          <SaveButton pending={savePending} label={saveLabel} onSave={save} />
        </div>
      </PageHeader>
      {children}
    </CompareEditContext.Provider>
  )
}
