"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ClipboardPaste, Trash2, Users } from "lucide-react"

import { deleteRecipe } from "@/app/(app)/recipes/actions"
import { ShareDialog } from "@/components/recipes/share-dialog"
import { ActionsMenu } from "@/components/ui/actions-menu"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { MenuItem } from "@/components/ui/menu"
import {
  PageHeader,
  PageParent,
  PageParents,
  PageTitle,
} from "@/components/ui/page"
import { SaveButton } from "@/components/ui/save-button"
import { SectionTab, SectionTabs } from "@/components/ui/section-tabs"
import { SaveStatus, type SaveStatusState } from "@/components/ui/save-status"
import { useToast } from "@/components/ui/toast"
import { useEditChrome } from "@/hooks/use-edit-chrome"
import type { RecipeDetail } from "@/lib/backend/types"
import { clampScaleFactor, formatAppliedScaleFactor } from "@/lib/recipe/scale"
import { useGuardedNavigate } from "@/components/navigation-blocker"

const TABS = [
  { slug: "recipe", label: "Recipe" },
  { slug: "cost", label: "Cost" },
  { slug: "nutrition", label: "Nutrition" },
] as const

type RecipeEditValue = {
  /**
   * How a tab hands its save to the header, and takes it back on the way out.
   * Every tab holds an edit — the recipe form, the sell price, the serving —
   * so the button follows the save that is registered rather than the path.
   */
  registerSave: (save: (() => Promise<unknown>) | null) => void
  dirty: boolean
  setDirty: (dirty: boolean) => void
  saveState: SaveStatusState
  setSaveState: (state: SaveStatusState) => void
  /**
   * What the last save made of the recipe. The screen stays mounted through
   * every save, a brand new recipe's first one included, so the ids the tabs
   * and Share need and the name in the breadcrumb come from here rather than
   * from another trip to the server.
   */
  setSaved: (recipe: { id: string; publicId: string; title: string }) => void
  openShare: () => void
  /** The screen puts its import dialog opener here; the Actions menu calls it. */
  importRef: React.RefObject<(() => void) | null>
  /** The batch the recipe is being looked at in: 1 is the original. */
  batch: BatchSize
  setBatch: (batch: BatchSize) => void
}

export type BatchSize = { label: string; scale: number; isOriginal: boolean }

const ORIGINAL: BatchSize = { label: "1x", scale: 1, isOriginal: true }

const RecipeEditContext = React.createContext<RecipeEditValue | null>(null)

function BatchFromUrl({
  setBatch,
}: {
  setBatch: React.Dispatch<React.SetStateAction<BatchSize>>
}) {
  const raw = useSearchParams().get("batch")
  React.useEffect(() => {
    if (raw === null) return
    const factor = clampScaleFactor(Number(raw))
    if (factor === null) return
    setBatch({
      label: `${formatAppliedScaleFactor(factor)}x`,
      scale: factor,
      isOriginal: factor === 1,
    })
  }, [raw, setBatch])
  return null
}

export function useRecipeEdit() {
  const value = React.useContext(RecipeEditContext)
  if (!value) {
    throw new Error("useRecipeEdit must be used inside RecipeChrome")
  }
  return value
}

/** The header and tab strip every recipe screen shares. */
export function RecipeChrome({
  id,
  title,
  publicId,
  status = "active",
  ownerName = "",
  shares = [],
  guestLinks = [],
  bookLinks = [],
  canEdit = true,
  canShare = canEdit,
  canDelete = false,
  canViewCost = false,
  children,
}: {
  id?: string
  title: string
  /** Absent on the create screen, which has no tabs. */
  publicId?: string
  status?: RecipeDetail["status"]
  ownerName?: string
  shares?: RecipeDetail["shares"]
  guestLinks?: RecipeDetail["guestLinks"]
  bookLinks?: RecipeDetail["bookLinks"]
  canEdit?: boolean
  /** Who may invite and revoke. Edit rights can be wider than the recipe's
   *  ownership, and sharing it out is not one of them. */
  canShare?: boolean
  canDelete?: boolean
  /** Cost is a separate tab, and it is only there for those allowed to see it. */
  canViewCost?: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
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
  const [shareOpen, setShareOpen] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deletePending, setDeletePending] = React.useState(false)
  const [canSave, setCanSave] = React.useState(false)
  const registerSave = React.useCallback(
    (next: (() => Promise<unknown>) | null) => {
      saveRef.current = next
      setCanSave(next !== null)
    },
    [saveRef]
  )
  const importRef = React.useRef<(() => void) | null>(null)
  const [batch, setBatch] = React.useState<BatchSize>(ORIGINAL)
  const [saved, setSaved] = React.useState<{
    id: string
    publicId: string
    title: string
  } | null>(null)
  const recipeId = id ?? saved?.id
  const recipePublicId = publicId ?? saved?.publicId
  const shownTitle = saved?.title || title
  // Drawn from the first paint for whoever may edit, rather than waiting for
  // the tab under it to load and register: a Save that arrives late is missed.
  const editing = canEdit || canSave
  // A new recipe is owned by whoever is creating it, so its owner-only tabs
  // and actions show from the start (disabled until it is saved, like the
  // other tabs) rather than appearing after the first save.
  const creating = id === undefined
  const showCost = canViewCost || creating
  const showDelete = canDelete || creating

  const openShare = React.useCallback(() => setShareOpen(true), [])

  const value = React.useMemo(
    () => ({
      registerSave,
      importRef,
      batch,
      setBatch,
      dirty,
      setDirty,
      saveState,
      setSaveState,
      setSaved,
      openShare,
    }),
    [batch, dirty, openShare, registerSave, saveState, setDirty, setSaveState]
  )

  return (
    <RecipeEditContext.Provider value={value}>
      <React.Suspense fallback={null}>
        <BatchFromUrl setBatch={setBatch} />
      </React.Suspense>
      <PageHeader className="flex-wrap items-center print:hidden">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            <PageParent href="/recipes">Recipes</PageParent>
          </PageParents>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <PageTitle>
              <span className="truncate">{shownTitle}</span>
            </PageTitle>
            {status === "archived" ? (
              <Badge className="shrink-0">Archived</Badge>
            ) : null}
            <SaveStatus
              state={saveState}
              dirty={dirty}
              saved={Boolean(recipePublicId)}
              fallback="New"
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Open before the first save: importing is how a new recipe
              gets its lines. Only sharing and deleting need a saved recipe. */}
          <ActionsMenu>
            {canEdit ? (
              <MenuItem onClick={() => importRef.current?.()}>
                <ClipboardPaste strokeWidth={1.8} aria-hidden="true" />
                Import recipe…
              </MenuItem>
            ) : null}
            <MenuItem disabled={!recipeId} onClick={openShare}>
              <Users strokeWidth={1.8} aria-hidden="true" />
              Share…
            </MenuItem>
            {showDelete ? (
              <MenuItem
                disabled={!recipeId}
                onClick={() => setConfirmDelete(true)}
                className="text-destructive data-highlighted:text-destructive"
              >
                <Trash2
                  className="text-current"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Delete recipe
              </MenuItem>
            ) : null}
          </ActionsMenu>
          {editing ? (
            <SaveButton pending={savePending} label={saveLabel} onSave={save} />
          ) : null}
        </div>
      </PageHeader>

      <SectionTabs>
        {TABS.filter((entry) => entry.slug !== "cost" || showCost).map(
          (entry) => {
            const href = recipePublicId
              ? `/recipes/${recipePublicId}/${entry.slug}`
              : undefined
            // A recipe that saved itself on this screen rewrote the address
            // bar without telling the router, so the path alone cannot say
            // which tab is open: the one being typed in is.
            const active = publicId
              ? pathname === href
              : entry.slug === "recipe"
            return (
              <SectionTab key={entry.slug} href={href} active={active}>
                {entry.label}
              </SectionTab>
            )
          }
        )}
      </SectionTabs>

      {children}

      {recipeId ? (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          recipeId={recipeId}
          ownerName={ownerName}
          shares={shares}
          guestLinks={guestLinks}
          bookLinks={bookLinks}
          canEdit={canShare}
        />
      ) : null}
      {recipeId && showDelete ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete this recipe?"
          description="The recipe and its steps, items and comments are removed for everyone it is shared with."
          confirmLabel="Delete recipe"
          pending={deletePending}
          onConfirm={async () => {
            setDeletePending(true)
            try {
              const result = await deleteRecipe(recipeId)
              if ("error" in result) {
                toast.add({ title: result.error, type: "error" })
                return
              }
              setDirty(false)
              // The confirmation leaves before the screen does: an open
              // dialog with a live button is not a delete that has happened.
              setConfirmDelete(false)
              void go("/recipes", { force: true })
              toast.add({ title: "Deleted recipe" })
            } finally {
              setDeletePending(false)
            }
          }}
        />
      ) : null}
    </RecipeEditContext.Provider>
  )
}
