"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { SaveButton } from "@/components/ui/save-button"
import { SectionTab, SectionTabs } from "@/components/ui/section-tabs"
import { SaveStatus, type SaveStatusState } from "@/components/ui/save-status"
import { useEditChrome } from "@/hooks/use-edit-chrome"

type MenuEditValue = {
  /** The screen puts its save here; the header's Save button calls it. */
  saveRef: React.RefObject<(() => Promise<unknown>) | null>
  dirty: boolean
  setDirty: (dirty: boolean) => void
  saveState: SaveStatusState
  setSaveState: (state: SaveStatusState) => void
}

const MenuEditContext = React.createContext<MenuEditValue | null>(null)

export function useMenuEdit() {
  const value = React.useContext(MenuEditContext)
  if (!value) {
    throw new Error("useMenuEdit must be used inside MenuChrome")
  }
  return value
}

/** The header every menu worksheet shares. */
export function MenuChrome({
  title,
  publicId,
  editable = true,
  children,
}: {
  title: string
  /** Absent on the create screen. */
  publicId?: string
  editable?: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
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
    <MenuEditContext.Provider value={value}>
      <PageHeader className="flex-wrap items-center">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/menu">Menus</PageParent>
          </PageParents>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <PageTitle>
              <span className="truncate">{title}</span>
            </PageTitle>
            {editable ? (
              <SaveStatus
                state={saveState}
                dirty={dirty}
                saved={Boolean(publicId)}
              />
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editable ? (
            <SaveButton pending={savePending} label={saveLabel} onSave={save} />
          ) : null}
        </div>
      </PageHeader>

      {publicId ? (
        <SectionTabs>
          {[
            {
              label: "Worksheet",
              href: `/menu/${encodeURIComponent(publicId)}`,
            },
            {
              label: "Matrix",
              href: `/menu/${encodeURIComponent(publicId)}/matrix`,
            },
            {
              label: "Forecast",
              href: `/menu/${encodeURIComponent(publicId)}/forecast`,
            },
          ].map((tab) => (
            <SectionTab
              key={tab.href}
              href={tab.href}
              active={pathname === tab.href}
            >
              {tab.label}
            </SectionTab>
          ))}
        </SectionTabs>
      ) : null}

      {children}
    </MenuEditContext.Provider>
  )
}
