"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  SquarePen,
  Trash2,
} from "lucide-react"

import {
  archiveIngredient,
  deletePreparations,
  savePreparation,
  updateIngredientNutritionSettings,
} from "@/app/(app)/ingredients/actions"
import { IngredientDeleteDialog } from "@/components/ingredients/ingredient-delete-dialog"
import {
  PreparationDialog,
  type PreparationInput,
} from "@/components/ingredients/preparation-dialog"
import {
  PurchaseUnitDialog,
  type PurchaseUnit,
} from "@/components/ingredients/purchase-unit-dialog"
import { useNavigationBlocker } from "@/components/navigation-blocker"
import { ActionsMenu } from "@/components/ui/actions-menu"
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
import { useCommit } from "@/hooks/use-commit"
import { useEditChrome } from "@/hooks/use-edit-chrome"
import { useRefresh } from "@/hooks/use-refresh"
import { savePurchaseUnit as writePurchaseUnit } from "@/lib/ingredients/save-purchase-unit"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import type { IngredientRow } from "@/lib/backend/types"

const TABS = [
  { slug: "ingredient", label: "Ingredient", disabled: false },
  { slug: "cost", label: "Cost", disabled: false },
  { slug: "nutrition", label: "Nutrition", disabled: false },
] as const

/** What a preparation delete comes back as: done, or refused with a list. */
export type PreparationDeleteResult =
  | { ok: true }
  | {
      error: string
      usedInRecipes?: Array<{ id: string; publicId: string; title: string }>
    }

type IngredientEditValue = {
  /** The screen puts its save here; the header's Save button calls it. */
  saveRef: React.RefObject<(() => Promise<unknown>) | null>
  setDirty: (dirty: boolean) => void
  setSaveState: (state: SaveStatusState) => void
  addPreparation: () => void
  editPreparation: (preparation: PreparationInput) => void
  removePreparations: (ids: string[]) => Promise<PreparationDeleteResult>
  purchaseUnit: PurchaseUnit | null
  /** The version the last pack write echoed, null until one lands. */
  packVersion: number | null
  editPurchaseUnit: (unit: PurchaseUnit) => void
  /** Null once the pack is written; the failure is the caller's to show. */
  savePurchaseUnit: (unit: PurchaseUnit) => Promise<SaveFailure | null>
  /** Everything on the ingredient tab that saves itself, by domain. */
  commit: ReturnType<typeof useCommit>
}

const IngredientEditContext = React.createContext<IngredientEditValue | null>(
  null
)

export function useIngredientEdit() {
  const value = React.useContext(IngredientEditContext)
  if (!value) {
    throw new Error("useIngredientEdit must be used inside IngredientChrome")
  }
  return value
}

/** The header and tab strip every ingredient screen shares. */
export function IngredientChrome({
  id,
  name,
  invoicePrices = [],
  publicId,
  status = "active",
  nonEdible = false,
  children,
}: {
  id?: string
  name: string
  /** Invoice purchases available to this ingredient's costing. */
  invoicePrices?: IngredientRow["invoicePrices"]
  /** What one of this ingredient comes to in other measures, if stated. */
  /** Absent on the create screen, which has no tabs. */
  publicId?: string
  /** Archived ingredients stay priced, they just leave the pickers. */
  status?: IngredientRow["status"]
  /** A supply: it browses under Supplies, and nothing about it is nutrition. */
  nonEdible?: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { refresh } = useRefresh()
  const toast = useToast()
  const { allowNavigation } = useNavigationBlocker()
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
  const [preparationOpen, setPreparationOpen] = React.useState(false)
  // The row being edited, so the dialog opens seeded and saves back onto it.
  const [preparationEdit, setPreparationEdit] =
    React.useState<PreparationInput | null>(null)
  const [purchaseUnit, setPurchaseUnit] = React.useState<PurchaseUnit | null>(
    null
  )
  const [purchaseTarget, setPurchaseTarget] =
    React.useState<PurchaseUnit | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [confirmConvert, setConfirmConvert] = React.useState(false)
  const [converting, setConverting] = React.useState(false)
  // An archive in flight: the menu that asked has closed, so the header pill
  // and the menu itself carry the wait.
  const [archiving, setArchiving] = React.useState(false)
  // The version a purchase-unit write echoed, for the form to save against.
  const [packVersion, setPackVersion] = React.useState<number | null>(null)
  const commit = useCommit({
    onSaveState: setSaveState,
    onSaved: () => refresh(),
    onVersion: setPackVersion,
  })

  const addPreparation = React.useCallback(() => {
    setPreparationEdit(null)
    setPreparationOpen(true)
  }, [])
  const editPreparation = React.useCallback((preparation: PreparationInput) => {
    setPreparationEdit(preparation)
    setPreparationOpen(true)
  }, [])
  // Answers with what came back rather than reporting it: the row's dialog
  // lists the recipes standing in the way, the selection bar toasts.
  const removePreparations = React.useCallback(
    async (ids: string[]): Promise<PreparationDeleteResult> => {
      let result: PreparationDeleteResult
      try {
        result = await deletePreparations(ids)
      } catch (cause) {
        // A stale tab's action id is gone from the server; unhandled, the
        // click dies with nothing on screen at all.
        result = { error: toSaveFailure(cause).message }
      }
      if ("ok" in result) await refresh()
      return result
    },
    [refresh]
  )

  const editPurchaseUnit = React.useCallback(
    (unit: PurchaseUnit) => setPurchaseTarget(unit),
    []
  )
  const archived = status === "archived"
  const toggleArchive = React.useCallback(async () => {
    if (!id) return
    setArchiving(true)
    setSaveState("saving")
    try {
      const result = await archiveIngredient(id, !archived)
      if ("error" in result) {
        setSaveState("error")
        toast.add({ title: result.error, type: "error" })
        return
      }
      await refresh()
      setSaveState("saved")
      toast.add({ title: archived ? `Restored ${name}` : `Archived ${name}` })
    } finally {
      setArchiving(false)
    }
  }, [archived, id, name, refresh, setSaveState, toast])

  // The "Not food" checkbox lives on the Nutrition tab, which a supply does
  // not have; this is how a supply becomes an ingredient again.
  const convert = React.useCallback(async () => {
    if (!id) return
    setConverting(true)
    try {
      const result = await updateIngredientNutritionSettings(id, {
        nonEdible: !nonEdible,
      })
      if ("error" in result) {
        toast.add({ title: result.error, type: "error" })
        return
      }
      // The confirm stays up, spinning, until the screen is the other kind.
      await refresh()
      setConfirmConvert(false)
    } finally {
      setConverting(false)
    }
  }, [id, nonEdible, refresh, toast])

  const savePurchaseUnit = React.useCallback(
    (unit: PurchaseUnit) => {
      // A pack typed on the create screen has nowhere to go yet: the form's
      // own save writes it with the rest of the ingredient.
      if (!id) {
        setPurchaseUnit(unit)
        setDirty(true)
        return Promise.resolve(null)
      }
      const previous = purchaseUnit
      return commit({
        domain: `ingredient:${id}:purchase-unit`,
        apply: () => setPurchaseUnit(unit),
        revert: () => setPurchaseUnit(previous),
        write: () => writePurchaseUnit({ id, unit }),
      }).then((failure) => {
        // The link is gone; a later edit must not ride the flag along.
        if (
          !failure &&
          (unit.invoiceLineId ||
            unit.disconnectInvoicePriceId ||
            unit.useInvoicePriceId)
        )
          setPurchaseUnit({
            ...unit,
            invoiceLineId: null,
            invoicePurchaseSize: "",
            invoicePurchaseUnit: "",
            disconnectInvoicePriceId: null,
            useInvoicePriceId: null,
          })
        return failure
      })
    },
    [commit, id, purchaseUnit, setDirty]
  )

  const value = React.useMemo(
    () => ({
      saveRef,
      setDirty,
      setSaveState,
      addPreparation,
      editPreparation,
      removePreparations,
      purchaseUnit,
      packVersion,
      editPurchaseUnit,
      savePurchaseUnit,
      commit,
    }),
    [
      commit,
      addPreparation,
      editPreparation,
      editPurchaseUnit,
      savePurchaseUnit,
      purchaseUnit,
      packVersion,
      removePreparations,
      saveRef,
      setDirty,
      setSaveState,
    ]
  )

  return (
    <IngredientEditContext.Provider value={value}>
      <PageHeader className="flex-wrap items-center print:hidden">
        <div className="flex min-w-0 flex-col gap-1">
          <PageParents>
            {nonEdible ? (
              <PageParent href="/supplies">Supplies</PageParent>
            ) : (
              <PageParent href="/ingredients">Ingredients</PageParent>
            )}
          </PageParents>
          <div className="flex min-w-0 items-baseline gap-2.5">
            <PageTitle>
              <span className="truncate">{name}</span>
            </PageTitle>
            {archived ? (
              <span className="shrink-0 text-2xs text-muted-foreground">
                Archived
              </span>
            ) : null}
            <SaveStatus
              state={saveState}
              dirty={dirty}
              saved={Boolean(publicId)}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ActionsMenu disabled={!id || archiving}>
            {nonEdible ? null : (
              <MenuItem disabled={!id} onClick={addPreparation}>
                <SquarePen strokeWidth={1.8} aria-hidden="true" />
                Add preparation
              </MenuItem>
            )}
            <MenuItem disabled={!id} onClick={() => setConfirmConvert(true)}>
              <ArrowLeftRight strokeWidth={1.8} aria-hidden="true" />
              {nonEdible ? "Convert to ingredient" : "Convert to supply"}
            </MenuItem>
            <MenuItem disabled={!id} onClick={() => void toggleArchive()}>
              {archived ? (
                <ArchiveRestore strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Archive strokeWidth={1.8} aria-hidden="true" />
              )}
              {archived
                ? `Restore ${nonEdible ? "supply" : "ingredient"}`
                : `Archive ${nonEdible ? "supply" : "ingredient"}`}
            </MenuItem>
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
              Delete {nonEdible ? "supply" : "ingredient"}
            </MenuItem>
          </ActionsMenu>
          <SaveButton pending={savePending} label={saveLabel} onSave={save} />
        </div>
      </PageHeader>

      {/* A supply is one page: nothing to split off into tabs. */}
      {nonEdible ? null : (
        <SectionTabs>
          {TABS.map((entry) => {
            const href =
              publicId && !entry.disabled
                ? `/ingredients/${publicId}/${entry.slug}`
                : undefined
            const active = publicId
              ? pathname === href
              : entry.slug === "ingredient"
            return (
              <SectionTab key={entry.slug} href={href} active={active}>
                {entry.label}
              </SectionTab>
            )
          })}
        </SectionTabs>
      )}

      {children}

      {/* Mounted per open, so a preparation that just saved never seeds the
          next one's fields. */}
      {preparationOpen ? (
        <PreparationDialog
          open
          initial={preparationEdit}
          onOpenChange={(next) => {
            setPreparationOpen(next)
            if (!next) setPreparationEdit(null)
          }}
          onAdd={async (preparation) => {
            if (!id) return null
            const result = await savePreparation({
              ingredientId: id,
              id: preparation.id,
              name: preparation.name,
              yieldPercent: preparation.yieldPercent,
              usesStandardConversion: preparation.usesStandardConversion,
              weight: preparation.weight,
              volume: preparation.volume,
              each: preparation.each,
            })
            if ("error" in result) return toSaveFailure(result)
            await refresh()
            return null
          }}
        />
      ) : null}

      {/* Mounted per open so the row being edited seeds the fields once. */}
      {purchaseTarget ? (
        <PurchaseUnitDialog
          open
          onOpenChange={(next) => {
            if (!next) setPurchaseTarget(null)
          }}
          initial={purchaseTarget}
          invoicePrices={invoicePrices}
          onSave={savePurchaseUnit}
          allowItemSync={Boolean(id)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmConvert}
        onOpenChange={setConfirmConvert}
        variant="default"
        title={nonEdible ? "Convert to an ingredient?" : "Convert to a supply?"}
        description={
          nonEdible
            ? `${name} moves to Ingredients and gets its Nutrition tab back, so it can carry allergens and a label again.`
            : `${name} moves to Supplies and drops off nutrition labels and allergens. Recipes stop offering it; products still can.`
        }
        confirmLabel={nonEdible ? "Convert to ingredient" : "Convert to supply"}
        pending={converting}
        onConfirm={convert}
      />

      {id ? (
        <IngredientDeleteDialog
          key={id}
          ingredient={{ id, name }}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onDeleted={() => {
            setDirty(false)
            allowNavigation()
            router.push(nonEdible ? "/supplies" : "/ingredients")
          }}
        />
      ) : null}
    </IngredientEditContext.Provider>
  )
}

/** The header belongs to the tab on screen: each hands it back on the way out,
 *  so the other tab's dirt never reaches this one's Save. */
export function useIngredientTabSave(claims = true) {
  const { saveRef, setDirty, setSaveState } = useIngredientEdit()

  // The tab's own form registers itself; only its exit clears the slot. A
  // section folded into another tab's form claims nothing, so it clears
  // nothing on the way out either.
  React.useEffect(() => {
    if (!claims) return
    return () => {
      saveRef.current = null
      setDirty(false)
      setSaveState("saved")
    }
  }, [claims, saveRef, setDirty, setSaveState])
}

/** Wires a screen's form to the header's Save. */
export function useIngredientFormBinding() {
  const { saveRef, setDirty, setSaveState, purchaseUnit, packVersion } =
    useIngredientEdit()
  useIngredientTabSave()

  return {
    saveRef,
    actions: false as const,
    onDirtyChange: setDirty,
    onSaveStateChange: setSaveState,
    purchaseUnit,
    packVersion,
  }
}
