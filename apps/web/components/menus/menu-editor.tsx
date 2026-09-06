"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Download, RotateCcw } from "lucide-react"

import { loadMenuProducts, saveMenu } from "@/app/(app)/menu/actions"
import { saveSalesProduct } from "@/app/(app)/products/actions"
import { saveRecipe } from "@/app/(app)/recipes/actions"
import { ImportProductsDialog } from "@/components/menus/import-products-dialog"
import { useMenuEdit } from "@/components/menus/menu-chrome"
import {
  MenuItemsTable,
  type MenuItemPatch,
  type MenuItemState,
  type MenuLinkTarget,
} from "@/components/menus/menu-items-table"
import { MenuSummaryCards } from "@/components/menus/menu-summary-cards"
import { useRecipeLimitDialog } from "@/components/recipes/recipe-limit-dialog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DateRangeFilter } from "@/components/ui/date-range-filter"
import { addDays, localDateKey } from "@/lib/date-presets"
import { LabeledInput } from "@/components/ui/labeled-field"
import { Toolbar, ToolbarSpacer } from "@/components/ui/page"
import { SaveBanner } from "@/components/ui/save-banner"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/toast"
import { useDocumentSave, type SaveEcho } from "@/hooks/use-document-save"
import { useRefresh } from "@/hooks/use-refresh"
import { menuDraft } from "@/lib/draft-store"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import type {
  MenuDetail,
  MenuItemRow,
  MenuProductOption,
  MenuRecipeOption,
  SalesProductRow,
} from "@/lib/backend/types"
import { deriveRows, originalFigures, summarize } from "@/lib/menu/engineering"

const TRACK_VARIANCE_KEY = "menu.trackVariance"

/** Three decimals is what the server keeps of a quantity, and the cell shows. */
const kept = (value: number) => Math.round(value * 1000) / 1000

// Leaves out keys, ids and snapshots, and normalizes what the server
// normalizes, so adopting the saved rows does not re-dirty the screen.
const snapshotOf = (
  name: string,
  periodStart: string | null,
  periodEnd: string | null,
  items: readonly MenuItemState[]
) =>
  JSON.stringify([
    name.trim(),
    periodStart,
    periodEnd,
    items.map((item) => [
      item.name.trim(),
      item.recipeId,
      item.productId,
      item.sellPriceCents,
      kept(item.qtySold),
    ]),
  ])

const key = () =>
  typeof crypto !== "undefined"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

function itemState(item: MenuItemRow): MenuItemState {
  return {
    key: item.id,
    id: item.id,
    name: item.name,
    category: item.category ?? "",
    sellPriceCents: item.sellPriceCents,
    // A product row's quantity is what sales say, so the stored column never
    // shadows a window that has moved since the last save.
    qtySold: item.productId ? (item.sourceQtySold ?? 0) : item.qtySold,
    recipeId: item.recipeId,
    recipePublicId: item.recipePublicId,
    productId: item.productId,
    productPublicId: item.productPublicId,
    foodCostCents: item.foodCostCents,
    sourceSellPriceCents: item.sourceSellPriceCents,
    sourceQtySold: item.sourceQtySold,
    original: item.original,
  }
}

/** What a recovered draft puts back, which is what `menuDraft` allowed out. */
type MenuRecovery = {
  name: string
  periodStart: string | null
  periodEnd: string | null
  items: MenuItemState[]
}

export function MenuEditor({
  initial,
  recipes,
  products,
  currencyCode,
  timeZone,
  currentUserId,
}: {
  initial: MenuDetail | null
  recipes: MenuRecipeOption[]
  products: MenuProductOption[]
  currencyCode: string
  timeZone: string
  currentUserId: string
}) {
  const router = useRouter()
  const { refresh } = useRefresh()
  const toast = useToast()
  const recipeLimit = useRecipeLimitDialog()
  const { saveRef, setDirty, setSaveState } = useMenuEdit()
  const nameRef = React.useRef<HTMLInputElement>(null)
  const [nameMissing, setNameMissing] = React.useState(false)

  const [menuId, setMenuId] = React.useState(initial?.menu.id ?? null)
  const [name, setName] = React.useState(initial?.menu.name ?? "")
  // A new menu reads the last 30 days; All time is a choice, not the default.
  const [periodStart, setPeriodStart] = React.useState(() =>
    initial ? initial.menu.periodStart : addDays(localDateKey(timeZone), -30)
  )
  const [periodEnd, setPeriodEnd] = React.useState(() =>
    initial ? initial.menu.periodEnd : addDays(localDateKey(timeZone), -1)
  )
  const [items, setItems] = React.useState<MenuItemState[]>(
    () => initial?.items.map(itemState) ?? []
  )
  const [trackVariance, setTrackVariance] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [rebaselineOpen, setRebaselineOpen] = React.useState(false)

  // This browser's last choice, read after mount: the server cannot know it.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrackVariance(window.localStorage.getItem(TRACK_VARIANCE_KEY) === "on")
  }, [])
  const chooseTrackVariance = (next: boolean) => {
    setTrackVariance(next)
    window.localStorage.setItem(TRACK_VARIANCE_KEY, next ? "on" : "off")
  }

  const figures = React.useMemo(
    () =>
      items.map((item) => ({
        sellPriceCents: item.sellPriceCents,
        qtySold: item.qtySold,
        foodCostCents: item.foodCostCents,
      })),
    [items]
  )
  const { rows: derived, summary } = React.useMemo(
    () => deriveRows(figures),
    [figures]
  )
  const originalSummary = React.useMemo(
    () =>
      summarize(
        figures.map((figure, index) =>
          originalFigures({ ...figure, original: items[index].original })
        )
      ),
    [figures, items]
  )

  // The chrome owns the Save button, so it needs to know the form changed.
  const snapshot = snapshotOf(name, periodStart, periodEnd, items)
  // Set by Reset baseline, kept until a save actually carries it to the server.
  const rebaselining = React.useRef(false)

  const save = async (
    expectedEditVersion: number | null,
    leaving: boolean
  ): Promise<SaveEcho | SaveFailure> => {
    const rebaseline = rebaselining.current
    if (!name.trim()) {
      setNameMissing(true)
      toast.add({ title: "Give the menu a name", type: "error" })
      nameRef.current?.focus()
      return { kind: "validation", message: "Give the menu a name" }
    }
    // An unlinked row is legal; a nameless one is nothing at all.
    if (
      items.some(
        (item) => !item.recipeId && !item.productId && !item.name.trim()
      )
    ) {
      toast.add({ title: "Name every item", type: "error" })
      return { kind: "validation", message: "Name every item" }
    }
    const creating = menuId === null
    const result = await saveMenu({
      id: menuId,
      ...(expectedEditVersion === null ? {} : { expectedEditVersion }),
      name: name.trim(),
      periodStart,
      periodEnd,
      ...(rebaseline ? { rebaseline: true } : {}),
      items: items.map((item, position) => ({
        id: item.id,
        name: item.name.trim(),
        recipeId: item.recipeId,
        productId: item.productId,
        sellPriceCents: item.sellPriceCents,
        qtySold: item.qtySold,
        position,
      })),
    })
    if ("error" in result) return toSaveFailure(result)
    if (rebaseline) rebaselining.current = false
    const adopted = result.items.map(itemState)
    setMenuId(result.menu.id)
    // Leaving: rewrite the entry being left, never navigate.
    if (leaving) {
      if (creating)
        window.history.replaceState(null, "", `/menu/${result.menu.publicId}`)
      return { editVersion: result.menu.editVersion }
    }
    if (creating) router.replace(`/menu/${result.menu.publicId}`)
    else void refresh()
    return {
      editVersion: result.menu.editVersion,
      // What the server stored, which is the same worksheet trimmed and
      // quantized, plus the ids the next save updates rather than re-creates.
      adopt: () => {
        setName(result.menu.name)
        setPeriodStart(result.menu.periodStart)
        setPeriodEnd(result.menu.periodEnd)
        setItems(adopted)
      },
    }
  }

  const { saveNow, conflict, restorable, dismissRestore, discardDraft } =
    useDocumentSave({
      snapshot,
      // A menu saves when the cook asks, or on the way off the page.
      active: false,
      wholeForm: true,
      kind: "menu",
      workspaceId: currentUserId,
      userId: currentUserId,
      recordId: menuId,
      editVersion: initial?.menu.editVersion ?? null,
      payload: () => menuDraft({ name, periodStart, periodEnd, items }),
      setDirty,
      setSaveState,
      save,
    })

  const report = (failure: SaveFailure | null) => {
    if (!failure) {
      toast.add({ title: "Menu saved", type: "success" })
      return
    }
    // A validation failure has already named the field it stopped on.
    if (failure.kind === "validation") return
    toast.add({
      title: "Couldn’t save",
      description: failure.message,
      type: "error",
    })
  }

  /** The same save, out loud: the header's Save button and Enter in the form. */
  const saveOnRequest = async () => report(await saveNow())

  const saveRebaseline = async () => {
    const failure = await saveNow()
    // The press may have ridden a save already in flight, which did not carry
    // the reset; the next one does.
    if (!failure && rebaselining.current) {
      report(await saveNow())
      return
    }
    report(failure)
  }

  // The Save button lives in the chrome, above this screen; it calls this.
  React.useEffect(() => {
    saveRef.current = saveOnRequest
    return () => {
      saveRef.current = null
    }
  })

  /** Put a recovered draft back on the screen, field for field. */
  const applyRecovery = (recovery: MenuRecovery) => {
    setName(recovery.name)
    setPeriodStart(recovery.periodStart)
    setPeriodEnd(recovery.periodEnd)
    setItems(recovery.items)
  }

  const patchItem = (itemKey: string, patch: MenuItemPatch) =>
    setItems((current) =>
      current.map((item) =>
        item.key === itemKey
          ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) }
          : item
      )
    )
  const addItem = (partial?: Partial<MenuItemState>) => {
    const itemKey = key()
    setItems((current) => [
      ...current,
      {
        key: itemKey,
        id: null,
        name: "",
        category: "",
        sellPriceCents: 0,
        qtySold: 0,
        recipeId: null,
        recipePublicId: null,
        productId: null,
        productPublicId: null,
        foodCostCents: null,
        sourceSellPriceCents: null,
        sourceQtySold: null,
        original: null,
        ...partial,
      },
    ])
    return itemKey
  }

  const linkTarget = (itemKey: string, target: MenuLinkTarget) => {
    if (target.kind === "recipe") {
      const recipe = target.recipe
      patchItem(itemKey, (item) => ({
        recipeId: recipe.id,
        recipePublicId: recipe.publicId,
        name: recipe.title,
        category: recipe.category ?? "",
        foodCostCents: recipe.ingredientCents,
        sourceSellPriceCents: recipe.menuPriceCents,
        sourceQtySold: null,
        sellPriceCents: item.sellPriceCents || (recipe.menuPriceCents ?? 0),
      }))
      return
    }
    patchItem(itemKey, {
      productId: target.id,
      productPublicId: target.publicId,
      name: target.name,
    })
    // The option list carries no figures; the worksheet endpoint reports the
    // product's category, price and units over the menu's period.
    void loadMenuProducts({
      q: target.name,
      start: periodStart,
      end: periodEnd,
    }).then((result) => {
      if ("error" in result) return
      const row = result.items.find((one) => one.id === target.id)
      if (!row) return
      patchItem(itemKey, (item) => ({
        category: row.category,
        sourceSellPriceCents: row.sellPriceCents || null,
        sourceQtySold: row.sales.totalQuantity,
        qtySold: row.sales.totalQuantity,
        sellPriceCents: item.sellPriceCents || row.sellPriceCents,
      }))
    })
  }

  const createProduct = async (itemKey: string, name: string) => {
    const item = items.find((one) => one.key === itemKey)
    const result = await saveSalesProduct({
      id: null,
      name,
      ...(item?.sellPriceCents ? { sellPriceCents: item.sellPriceCents } : {}),
    })
    if ("error" in result) {
      toast.add({
        title: "Couldn’t create the product",
        description: result.error,
        type: "error",
      })
      return
    }
    patchItem(itemKey, {
      productId: result.id,
      productPublicId: result.publicId,
      name,
    })
  }

  const createRecipe = async (itemKey: string, title: string) => {
    const result = await saveRecipe({ id: null, title })
    if ("error" in result) {
      if (recipeLimit.show(result)) return
      toast.add({
        title: "Couldn’t create the recipe",
        description: result.error,
        type: "error",
      })
      return
    }
    patchItem(itemKey, {
      recipeId: result.id,
      recipePublicId: result.publicId,
      name: title,
    })
  }

  const productIds = React.useMemo(
    () =>
      new Set(
        items
          .map((item) => item.productId)
          .filter((one): one is string => one !== null)
      ),
    [items]
  )
  const importProducts = (rows: SalesProductRow[]) => {
    const added = rows
      .filter((row) => !productIds.has(row.id))
      .map((row) => ({
        key: key(),
        id: null,
        name: row.name,
        category: row.category,
        sellPriceCents: row.sellPriceCents,
        qtySold: row.sales.totalQuantity,
        recipeId: null,
        recipePublicId: null,
        productId: row.id,
        productPublicId: row.publicId,
        // Costed on the server; the save's echo fills it in.
        foodCostCents: null,
        sourceSellPriceCents: row.sellPriceCents || null,
        sourceQtySold: row.sales.totalQuantity,
        original: null,
      }))
    if (added.length === 0) return
    setItems((current) => [...current, ...added])
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveOnRequest()
      }}
      className="grid w-full gap-6 pb-16"
      aria-label="Menu"
    >
      {conflict ? (
        <SaveBanner text={conflict.message}>
          <Button
            type="button"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              discardDraft()
              window.location.reload()
            }}
          >
            Discard my changes
          </Button>
        </SaveBanner>
      ) : null}
      {restorable ? (
        <SaveBanner text="This device kept changes that never reached the server.">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              applyRecovery(restorable as MenuRecovery)
              dismissRestore()
            }}
          >
            Restore
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={discardDraft}
          >
            Discard
          </Button>
        </SaveBanner>
      ) : null}
      <LabeledInput
        ref={nameRef}
        label="Name (required)"
        value={name}
        aria-invalid={nameMissing || undefined}
        onChange={(event) => {
          setName(event.target.value)
          if (event.target.value.trim()) setNameMissing(false)
        }}
      />

      <div className="grid gap-6">
        <Toolbar className="mb-0">
          <DateRangeFilter
            selectedStartDate={periodStart}
            selectedEndDate={periodEnd}
            timeZone={timeZone}
            onSelectedDateRangeChange={(start, end) => {
              setPeriodStart(start)
              setPeriodEnd(end)
            }}
            onClear={() => {
              setPeriodStart(null)
              setPeriodEnd(null)
            }}
          />
          <ToolbarSpacer />
          {/* One phone line for the three, one desktop row as before. */}
          <div className="flex flex-wrap items-center gap-2 md:contents">
            {/* Before the toggle, so appearing never moves the toggle. */}
            {trackVariance ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-primary hover:bg-brand/10 hover:text-primary"
                onClick={() => setRebaselineOpen(true)}
              >
                <RotateCcw strokeWidth={1.8} aria-hidden="true" />
                Reset baseline
              </Button>
            ) : null}
            <label className="flex h-8 items-center gap-2.5 text-sm font-medium text-foreground">
              <Switch
                size="sm"
                checked={trackVariance}
                onCheckedChange={chooseTrackVariance}
              />
              Track variance
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportOpen(true)}
            >
              <Download strokeWidth={1.8} aria-hidden="true" />
              Import from products
            </Button>
          </div>
        </Toolbar>

        <MenuSummaryCards
          summary={summary}
          original={originalSummary}
          trackVariance={trackVariance}
          currencyCode={currencyCode}
        />

        <MenuItemsTable
          items={items}
          derived={derived}
          recipes={recipes}
          products={products}
          currencyCode={currencyCode}
          onPatch={patchItem}
          onLinkTarget={linkTarget}
          onCreateRecipe={(itemKey, title) => void createRecipe(itemKey, title)}
          onCreateProduct={(itemKey, name) => void createProduct(itemKey, name)}
          onAdd={addItem}
          onRemove={(itemKey) =>
            setItems((current) =>
              current.filter((item) => item.key !== itemKey)
            )
          }
        />
      </div>

      {recipeLimit.dialog}

      <ImportProductsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        periodStart={periodStart}
        periodEnd={periodEnd}
        existingProductIds={productIds}
        currencyCode={currencyCode}
        onImport={importProducts}
      />

      <ConfirmDialog
        open={rebaselineOpen}
        onOpenChange={setRebaselineOpen}
        title="Reset the baseline?"
        description="Today’s prices, quantities and food costs become the Original every variance is measured from."
        confirmLabel="Reset baseline"
        variant="default"
        onConfirm={() => {
          setRebaselineOpen(false)
          rebaselining.current = true
          void saveRebaseline()
        }}
      />
    </form>
  )
}
