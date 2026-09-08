"use client"

import * as React from "react"
import {
  GripVertical,
  Info,
  Timer,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"

import {
  saveRecipeAggregate,
  deleteRecipeComment,
  saveRecipeComment,
} from "@/app/(app)/recipes/actions"
import {
  activateCatalogIngredient,
  searchCatalogIngredients,
} from "@/app/(app)/ingredients/actions"
import {
  ImportRecipeDialog,
  type ImportPart,
} from "@/components/recipes/import-recipe-dialog"
import {
  RecipeItemsTable,
  type Subrecipe,
} from "@/components/recipes/recipe-items-table"
import type { BatchSize } from "@/components/recipes/recipe-chrome"
import { useRecipeEdit } from "@/components/recipes/recipe-chrome"
import { useDocumentSave, type SaveEcho } from "@/hooks/use-document-save"
import { useHydrated } from "@/hooks/use-hydrated"
import { UnitConversionFields } from "@/components/unit-conversion-fields"
import { IngredientTagsCard } from "@/components/ingredients/ingredient-tags-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import { Input } from "@/components/ui/input"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { SaveBanner } from "@/components/ui/save-banner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AddButton } from "@/components/ui/add-button"
import { MeasureField } from "@/components/ui/measure-field"
import { BatchSizeSelect } from "@/components/recipes/batch-size-select"
import { CategoryCombobox } from "@/components/recipes/category-combobox"
import {
  BUILT_IN_BATCHES,
  ORIGINAL_BATCH,
} from "@/components/recipes/batch-size-select"
import { CustomBatchDialog } from "@/components/recipes/custom-batch-dialog"
import { useRecipeLimitDialog } from "@/components/recipes/recipe-limit-dialog"
import {
  UsedInList,
  useUsedInRows,
  type UsedInRecipe,
} from "@/components/recipes/used-in-list"
import {
  HEADING_PATTERN,
  NOTE_PATTERN,
  PERCENT_MODE_KEY,
} from "@/components/recipes/recipe-items-table"
import {
  dragHandleClassName,
  useSortableRows,
} from "@/components/recipes/use-sortable-rows"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { formatFullDate } from "@/lib/datetime"
import { useToast } from "@/components/ui/toast"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { recipeDraft } from "@/lib/draft-store"
import { toSaveFailure, type SaveFailure } from "@/lib/save-failure"
import { observedSecondsForBatch } from "@/lib/benchcost/math"
import type {
  IngredientTagOptionRow,
  PricingEntries,
  RecipeDetail,
} from "@/lib/backend/types"
import {
  batchAmountIn,
  clampRecipeQuantity,
  formatKitchenAmount,
  formatScaledWeight,
  parseRecipeText,
  weighRecipeLines,
  yieldFamily,
} from "@/lib/recipe"
import type { WeighReason } from "@/lib/recipe"
import type { RecipeCategory } from "@/lib/recipe/categories"
import type { RecipeStatus } from "@/lib/recipe/status"
import { resolveLine } from "@/lib/recipe/resolve-line"
import {
  YIELD_UNIT_VALUES,
  conversionUnitOptions,
  convertAmount,
  countedAsEach,
  unitShort,
  unitWord,
  yieldUnitOptions,
} from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

type ItemKind = "header" | "note" | "ingredient" | "subrecipe"
type StepKind = "instruction" | "header" | "note"
type ItemState = {
  key: string
  kind: ItemKind
  displayName: string
  quantity: string
  unit: string
  preparationNote: string
  efficiency: string
  efficiencyAfterCooking: string
  isBase: boolean
  excludedFromCost: boolean
  ingredientId: string | null
  subrecipeId: string | null
  /** The linked recipe's public id, which is what its URL is written with. */
  subrecipePublicId?: string | null
  /** The linked recipe one level deep, so the row can expand in place. */
  subrecipe?: Subrecipe | null
}

type StepState = {
  key: string
  kind: StepKind
  title: string
  body: string
  laborKind: "" | "active" | "passive"
  timings: Array<{ seconds: string; yieldCount: string }>
  media: Array<{
    id: string
    url: string
    thumbnailUrl: string
    mobileUrl: string
    altText: string
  }>
}

type EquivalencyState = {
  massAmount: string
  massUnit: string
  volumeAmount: string
  volumeUnit: string
  countAmount: string
  countUnit: string
  standard: boolean
}

/**
 * Everything the editor holds, which is exactly what a save sends. Stringified
 * it is also the dirty check: the form is dirty while it reads differently
 * from what the last save put on the server.
 */
type RecipeDraft = {
  customBatches: BatchSize[]
  title: string
  description: string
  status: RecipeStatus
  category: string
  yieldAmount: string
  yieldUnit: string
  shelfLifeAmount: string
  shelfLifeUnit: string
  prepTimeAmount: string
  prepTimeUnit: string
  autoSumYieldEnabled: boolean
  autoPrepTimeEnabled: boolean
  percentageMode: string
  percentIngredientEnabled: boolean
  percentIngredientType: string
  items: ItemState[]
  steps: StepState[]
  equivalency: EquivalencyState | null
  tags: string[]
}

/**
 * What Save sends for the equivalency. A family the cook left blank goes as
 * blank on both sides: the unit picker always shows a unit, and the recipe
 * refuses a unit with no amount beside it.
 */
function equivalencyPayload(state: EquivalencyState) {
  const measure = (amount: string, unit: string) =>
    amount.trim() && Number(amount) > 0
      ? { amount: Number(amount), unit }
      : { amount: null, unit: "" }
  const mass = measure(state.massAmount, state.massUnit)
  const volume = measure(state.volumeAmount, state.volumeUnit)
  const count = measure(state.countAmount, state.countUnit)
  return {
    massAmount: mass.amount,
    massUnit: mass.unit,
    volumeAmount: volume.amount,
    volumeUnit: volume.unit,
    countAmount: count.amount,
    countUnit: count.unit,
    standard: state.standard,
  }
}

/** The recipe as it was loaded: where the form starts. */
/** The custom batches a recipe keeps, read off the wire without built-ins. */
function customBatchesFrom(initial: RecipeDetail | null): BatchSize[] {
  return (initial?.batchSizes ?? [])
    .filter(
      (size) =>
        !size.isOriginal &&
        !BUILT_IN_BATCHES.some(
          (built) => built.scale === size.scale && built.label === size.label
        )
    )
    .map(({ label, scale }) => ({ label, scale, isOriginal: false }))
}

function draftFromInitial(initial: RecipeDetail | null): RecipeDraft {
  return {
    customBatches: customBatchesFrom(initial),
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    status: initial?.status ?? "active",
    category: initial?.category ?? "",
    yieldAmount:
      initial?.yieldAmount == null ? "" : String(initial.yieldAmount),
    // A new recipe has no implied yield family. Choosing the unit is what
    // distinguishes a 1,000 g batch from 1,000 pieces.
    yieldUnit: initial?.yieldUnit ?? "",
    shelfLifeAmount:
      initial?.shelfLifeAmount == null ? "" : String(initial.shelfLifeAmount),
    shelfLifeUnit: initial?.shelfLifeUnit ?? "",
    prepTimeAmount:
      initial?.prepTimeAmount == null ? "" : String(initial.prepTimeAmount),
    prepTimeUnit: initial?.prepTimeUnit ?? "",
    autoSumYieldEnabled: initial?.autoSumYieldEnabled ?? false,
    autoPrepTimeEnabled: initial?.autoPrepTimeEnabled ?? false,
    percentageMode: initial?.percentageMode ?? "",
    percentIngredientEnabled: initial?.percentIngredientEnabled ?? false,
    percentIngredientType: initial?.percentIngredientType ?? "",
    items: initial?.items.map(itemState) ?? [],
    steps: initial?.steps.map(stepState) ?? [],
    equivalency: initial?.equivalency
      ? {
          massAmount:
            initial.equivalency.massAmount == null
              ? ""
              : String(initial.equivalency.massAmount),
          massUnit: initial.equivalency.massUnit,
          volumeAmount:
            initial.equivalency.volumeAmount == null
              ? ""
              : String(initial.equivalency.volumeAmount),
          volumeUnit: initial.equivalency.volumeUnit,
          countAmount:
            initial.equivalency.countAmount == null
              ? ""
              : String(initial.equivalency.countAmount),
          countUnit: initial.equivalency.countUnit,
          standard: initial.equivalency.standard,
        }
      : null,
    tags: initial?.tags.map((tag) => tag.name) ?? [],
  }
}

type Props = {
  initial: RecipeDetail | null
  sources: PricingEntries
  categoryOptions: RecipeCategory[]
  /** Who is looking: a comment's author may remove it, as may the owner. */
  currentUserId: string
  /** The kitchen a new recipe belongs to; absent is the caller's own. */
  ownerId?: string
  tagOptions?: IngredientTagOptionRow[]
}
const inputClass = "bg-card"
const CONVERSION_UNITS = conversionUnitOptions()
const YIELD_UNIT_OPTIONS = yieldUnitOptions()
/** "an each count", "a slice count": the article the word asks for. */
const indefinite = (word: string) =>
  /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`

/**
 * What a row has to gain before the sum can include it. The unit is named
 * because "cup" is the whole answer: the ingredient needs a weight for it.
 */
function weighReasonLabel(
  reason: WeighReason,
  unit: string,
  yieldUnit: string,
  displayName: string
): string | null {
  // A yield counted in slices asks the ingredient for the same "each"
  // conversion a yield counted in pieces does.
  const target = unitWord(countedAsEach(yieldUnit))
  switch (reason) {
    // The name field already flags an unlinked row; a second triangle on the
    // quantity would say the same thing in a stranger place.
    case "unlinked":
      return null
    case "no-quantity":
      return "No quantity"
    case "no-conversion":
      return `Needs ${unitWord(unit)} to ${target} on the ingredient`
    // Nothing relates the line's family to the yield's, and only the
    // sub-recipe can say: one batch of it in both is what a share of a batch
    // is worked out from.
    case "sub-recipe": {
      const family = yieldFamily(yieldUnit)
      const measure =
        family === "mass"
          ? "a weight"
          : family === "volume"
            ? "a volume"
            : `${indefinite(target)} count`
      const name = displayName.trim() || "this sub-recipe"
      return `Add ${measure} to ${name}'s UOM`
    }
    default:
      return null
  }
}

const SHELF_LIFE_UNITS = [
  { slug: "hours", label: "Hours" },
  { slug: "days", label: "Days" },
  { slug: "weeks", label: "Weeks" },
  { slug: "months", label: "Months" },
]
const PREP_TIME_UNITS = [
  { slug: "minutes", label: "Minutes" },
  { slug: "hours", label: "Hours" },
]
const prepTimeDivisor = (unit: string) => (unit === "hours" ? 3600 : 60)
/** The seconds in the field's own unit, to two decimals with no trailing zeros. */
const prepTimeAmountOf = (seconds: number, unit: string) =>
  String(Math.round((seconds / prepTimeDivisor(unit)) * 100) / 100)
/** Whole hours read as hours; everything else reads as minutes. */
const prepTimeUnitFor = (seconds: number | null) =>
  seconds !== null && seconds >= 3600 && seconds % 3600 === 0
    ? "hours"
    : "minutes"
/** What the step's time button says: the time once set, else just "Time". */
const stepTimeLabel = (step: StepState) => {
  const seconds = Number(step.timings[0]?.seconds ?? 0)
  if (!(seconds > 0)) return "Time"
  const unit = prepTimeUnitFor(seconds)
  return `${prepTimeAmountOf(seconds, unit)} ${unit === "hours" ? "h" : "min"}`
}
const key = () =>
  typeof crypto !== "undefined"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

/**
 * A pasted method as steps, one line each: "# Bake" or "Bake:" is a section,
 * "> rest overnight" is a note, everything else is an instruction. Both the
 * import dialog and a paste into the quick-add field come through here, so a
 * cook gets the same steps whichever way the text arrived.
 */
function stepsFromText(text: string): StepState[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const heading =
        line.match(HEADING_PATTERN) ?? line.match(/^([^:]{1,80}):$/)
      const note = line.match(NOTE_PATTERN)
      return {
        key: key(),
        kind: (heading ? "header" : note ? "note" : "instruction") as StepKind,
        title: heading ? heading[1] : "",
        body: heading ? "" : note ? note[1] : line,
        laborKind: "active" as const,
        timings: [],
        media: [],
      }
    })
}

function itemState(item: RecipeDetail["items"][number]): ItemState {
  return {
    key: item.id,
    kind: item.kind,
    displayName: item.displayName,
    quantity: item.quantity === null ? "" : String(item.quantity),
    unit: item.unit,
    preparationNote: item.preparationNote,
    efficiency: String(item.efficiency),
    efficiencyAfterCooking: String(item.efficiencyAfterCooking),
    isBase: item.isBase,
    excludedFromCost: item.excludedFromCost,
    ingredientId: item.ingredientId,
    subrecipeId: item.subrecipeId,
    subrecipePublicId: item.subrecipe?.publicId ?? null,
    subrecipe: item.subrecipe,
  }
}
function stepState(step: RecipeDetail["steps"][number]): StepState {
  return {
    key: step.id,
    kind: step.kind,
    title: step.title,
    body: step.body,
    laborKind: step.laborKind,
    timings: step.timings.map((timing) => ({
      seconds: String(timing.seconds),
      yieldCount: String(timing.yieldCount),
    })),
    media: (step.media ?? []).map((media) => ({
      id: media.id,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl,
      mobileUrl: media.mobileUrl,
      altText: media.altText,
    })),
  }
}
function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-2 text-sm font-medium text-foreground">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** A typed 0 clears the field rather than failing the save. */
const amountOf = (amount: string) =>
  Number(amount) > 0 ? Number(amount) : null

/** An amount needs its unit before it can be saved; a unit alone is fine. */
const wholePair = (amount: string, unit: string) =>
  amountOf(amount) === null || unit !== ""

const pairIncomplete = (amount: string, unit: string) =>
  !wholePair(amount, unit)

/**
 * The one-line note under a measure field. Its space is always held so filling
 * the field never shifts the fields beside it or the sections below, and it
 * sits outside the field's <label> so its text is not read as the label.
 */
function HintLine({
  error,
  children,
}: {
  error?: boolean
  children?: React.ReactNode
}) {
  return (
    <p
      role={error && children ? "alert" : undefined}
      className={cn(
        "text-xs font-normal",
        error ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {children ?? "\u00a0"}
    </p>
  )
}

const EMPTY_SELECT_VALUE = "__empty__"

function OptionSelect({
  value,
  onChange,
  options,
  label,
  placeholder = "Select",
  disabled = false,
  size = "default",
  allowEmpty = false,
}: {
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  /** The accessible name, since a `LabeledShell` label is decorative. */
  label: string
  placeholder?: string
  disabled?: boolean
  /** Whether "no value" is a choice the list offers, not just a start state. */
  allowEmpty?: boolean
  size?: "sm" | "default"
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <Select
      value={value || EMPTY_SELECT_VALUE}
      disabled={disabled}
      onValueChange={(next) =>
        onChange(next === EMPTY_SELECT_VALUE ? "" : String(next))
      }
    >
      <SelectTrigger
        size={size}
        aria-label={label}
        className={labeledControlClassName}
      >
        <SelectValue>{selected?.label ?? placeholder}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowEmpty ? (
          <SelectItem value={EMPTY_SELECT_VALUE}>{placeholder}</SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const NO_USES: UsedInRecipe[] = []

/** What a recovered draft puts back, which is what `recipeDraft` allowed out. */
type RecipeRecovery = {
  title: string
  description: string
  items: ItemState[]
  steps: StepState[]
  batchSizes: BatchSize[]
  equivalency: EquivalencyState | null
  tags: string[]
}

function Section({
  title,
  description,
  children,
  action,
  className,
}: {
  title?: React.ReactNode
  description?: string
  children: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "border-t-[6px] border-secondary pt-7 first:border-t-0 first:pt-0",
        className
      )}
    >
      {title ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function RecipeEditor({
  initial,
  sources,
  categoryOptions,
  currentUserId,
  ownerId,
  tagOptions = [],
}: Props) {
  const toast = useToast()
  // Until React owns the page, what is typed into it would be lost.
  const hydrated = useHydrated()
  React.useEffect(() => {
    if (window.location.hash !== "#uom-equivalency") return
    window.requestAnimationFrame(() =>
      document.getElementById("uom-equivalency")?.focus({ preventScroll: true })
    )
  }, [])
  const { measurementSystem, timezone } = useBusinessSettings()
  const {
    registerSave,
    importRef,
    batch,
    setBatch,
    dirty,
    setDirty,
    saveState,
    setSaveState,
    setSaved,
  } = useRecipeEdit()
  const titleRef = React.useRef<HTMLInputElement>(null)
  // A new recipe starts at its name; the field is read-only until React owns
  // the page, so wait for that before taking the cursor.
  React.useEffect(() => {
    if (initial || !hydrated) return
    titleRef.current?.focus()
  }, [initial, hydrated])
  const usedInRows = useUsedInRows(initial?.usedIn ?? NO_USES)
  const [recipeId, setRecipeId] = React.useState(initial?.id ?? null)
  // Read by the save itself: a change queued behind the create runs before
  // React has re-rendered with the new id, and must not create twice.
  const recipeIdRef = React.useRef(recipeId)
  // The recipe as the server told it when the page opened.
  const [pristine] = React.useState(() => draftFromInitial(initial))
  const [title, setTitle] = React.useState(pristine.title)
  const [description, setDescription] = React.useState(pristine.description)
  const [status, setStatus] = React.useState<RecipeStatus>(pristine.status)
  const [category, setCategory] = React.useState(pristine.category)
  const [yieldAmount, setYieldAmount] = React.useState(pristine.yieldAmount)
  const [yieldUnit, setYieldUnit] = React.useState(
    pristine.yieldUnit || (pristine.autoSumYieldEnabled ? "g" : "")
  )
  const [shelfLifeAmount, setShelfLifeAmount] = React.useState(
    pristine.shelfLifeAmount
  )
  const [shelfLifeUnit, setShelfLifeUnit] = React.useState(
    pristine.shelfLifeUnit
  )
  const [prepTimeAmount, setPrepTimeAmount] = React.useState(
    pristine.prepTimeAmount
  )
  const [prepTimeUnit, setPrepTimeUnit] = React.useState(pristine.prepTimeUnit)
  const typedYieldRef = React.useRef<string | null>(null)
  const typedPrepRef = React.useRef<string | null>(null)
  const [autoPrepTimeEnabled, setAutoPrepTimeEnabled] = React.useState(
    pristine.autoPrepTimeEnabled
  )
  const [autoSumYieldEnabled, setAutoSumYieldEnabled] = React.useState(
    pristine.autoSumYieldEnabled
  )
  const [percentageMode, setPercentageMode] = React.useState(
    pristine.percentageMode
  )
  const [percentIngredientEnabled, setPercentIngredientEnabled] =
    React.useState(pristine.percentIngredientEnabled)
  const [percentIngredientType, setPercentIngredientType] = React.useState(
    pristine.percentIngredientType
  )
  const [items, setItems] = React.useState<ItemState[]>(pristine.items)
  const [invalidKey, setInvalidKey] = React.useState<string | null>(null)
  const [steps, setSteps] = React.useState<StepState[]>(pristine.steps)
  const [equivalency, setEquivalency] = React.useState<EquivalencyState | null>(
    pristine.equivalency
  )
  const [tags, setTags] = React.useState<string[]>(pristine.tags)
  const [commentDraft, setCommentDraft] = React.useState("")
  const [commentError, setCommentError] = React.useState<string | null>(null)
  // "new" while a comment is being posted, else the id being removed.
  const [commentBusy, setCommentBusy] = React.useState<string | null>(null)
  const [importPart, setImportPart] = React.useState<ImportPart | null>(null)
  const [customOpen, setCustomOpen] = React.useState(false)
  // The custom batches this recipe keeps: named once in the calculator,
  // listed beside the built-ins from then on, removable from the same menu.
  const sameBatch = (a: BatchSize, b: BatchSize) =>
    a.scale === b.scale && a.label === b.label
  const [customBatches, setCustomBatches] = React.useState<BatchSize[]>(() =>
    customBatchesFrom(initial)
  )
  const [laborKey, setLaborKey] = React.useState<string | null>(null)
  const [laborTime, setLaborTime] = React.useState({
    amount: "",
    unit: "minutes",
  })
  // No permission fields means no claim on the recipe.
  const canEdit = initial ? initial.canEdit === true : true
  const owner = initial?.permission === "owner" || !initial
  // A catalog pick materializes a pantry row mid-edit; the picker has to see
  // it on the next line without a reload, and still follow the props when a
  // refresh brings rows other flows created.
  const [activated, setActivated] = React.useState<
    { id: string; name: string; preparations?: string[] }[]
  >([])
  const ingredientTargets = React.useMemo<
    { id: string; name: string; preparations?: string[]; nonEdible?: boolean }[]
  >(() => {
    const preparations = new Map(
      sources.items.map((entry) => [
        entry.id,
        (entry.preparations ?? []).map((one) => one.name),
      ])
    )
    // `initial.ingredientOptions` arrives without supplies; the pricing
    // entries keep theirs, so the picker is what leaves them off a line.
    const known = (
      initial
        ? initial.ingredientOptions
        : sources.items.map(({ id, name, nonEdible }) => ({
            id,
            name,
            nonEdible,
          }))
    ).map((row) => ({ ...row, preparations: preparations.get(row.id) ?? [] }))
    return [
      ...known,
      ...activated.filter((row) => !known.some((one) => one.id === row.id)),
    ]
  }, [initial, sources.items, activated])
  const recipeTargets = initial
    ? initial.recipeOptions
    : sources.recipes.map(({ id, title }) => ({ id, title }))

  // The chrome owns the Save button, so it needs to know the form changed.
  // One snapshot beats threading a dirty flag through every setter below, and
  // the same snapshot is what the autosave watches.
  const draft: RecipeDraft = {
    title: title.trim(),
    description,
    status,
    category,
    yieldAmount,
    yieldUnit,
    shelfLifeAmount,
    shelfLifeUnit,
    prepTimeAmount,
    prepTimeUnit,
    autoSumYieldEnabled,
    autoPrepTimeEnabled,
    percentageMode,
    percentIngredientEnabled,
    percentIngredientType,
    items,
    steps,
    equivalency,
    tags,
    customBatches,
  }
  // The nested sub-recipe payload is the server's, not the cook's: adopting it
  // after a save must not read as an unsaved change.
  const snapshot = JSON.stringify(draft, (key, value) =>
    key === "subrecipe" ? undefined : value
  )

  const actionError = (result: unknown) =>
    result &&
    typeof result === "object" &&
    "error" in result &&
    typeof result.error === "string"
      ? result.error
      : ""

  /** A comment saves on its own button, so it says its own failures. */
  const notifyError = (result: unknown) => {
    if (!actionError(result)) return
    toast.add({
      title: "Couldn’t save",
      description: toSaveFailure(result).message,
      type: "error",
    })
  }

  // A half-typed pair is left as stored; the form stays a draft meanwhile.
  const wholeForm =
    wholePair(yieldAmount, yieldUnit) &&
    wholePair(shelfLifeAmount, shelfLifeUnit) &&
    wholePair(prepTimeAmount, prepTimeUnit)

  const recipeLimit = useRecipeLimitDialog()

  /** One save, whoever asked for it. */
  const save = async (
    expectedEditVersion: number | null,
    leaving: boolean
  ): Promise<SaveEcho | SaveFailure> => {
    if (!canEdit) {
      return { kind: "validation", message: "You can’t edit this recipe" }
    }
    const creating = recipeIdRef.current === null
    // A recipe with no name yet is still a recipe: it saves under a
    // placeholder rather than holding every other edit hostage.
    const name = title.trim() || "Untitled"
    try {
      const normalizedItems = items.map((item) => ({
        id: item.key,
        kind: item.kind,
        displayName: item.displayName,
        // Six decimals is what the quantity column holds: a third of a cup
        // typed as "1/3" must not arrive as sixteen digits the save refuses.
        quantity: item.quantity
          ? Number(clampRecipeQuantity(item.quantity))
          : null,
        unit: item.unit,
        preparationNote: item.preparationNote,
        efficiency: Number(item.efficiency || 100),
        efficiencyAfterCooking: Number(item.efficiencyAfterCooking || 100),
        isBase: item.isBase,
        ...(owner && (!ownerId || ownerId === currentUserId)
          ? { excludedFromCost: item.excludedFromCost }
          : {}),
        ingredientId: item.kind === "ingredient" ? item.ingredientId : null,
        subrecipeId: item.kind === "subrecipe" ? item.subrecipeId : null,
      }))
      const normalizedSteps = steps.map((step) => ({
        kind: step.kind,
        title: step.title,
        body: step.body,
        laborKind: step.laborKind,
        timings: step.timings.map((timing) => ({
          seconds: Number(timing.seconds || 1),
          yieldCount: Number(timing.yieldCount || 1),
        })),
      }))
      const profile = await saveRecipeAggregate(
        owner
          ? {
              id: recipeIdRef.current,
              // Only a create can choose its kitchen; a saved recipe already
              // has one.
              ...(creating && ownerId ? { ownerId } : {}),
              ...(expectedEditVersion === null ? {} : { expectedEditVersion }),
              title: name,
              description,
              // The legacy kind column remains for the staged backend
              // contract; normalized recipes are always ordinary recipes.
              kind: "recipe",
              status,
              body: "",
              method: "",
              ...(wholePair(yieldAmount, yieldUnit)
                ? {
                    yieldAmount: amountOf(yieldAmount),
                    ...(yieldUnit
                      ? {
                          yieldUnit:
                            yieldUnit as (typeof YIELD_UNIT_VALUES)[number],
                        }
                      : {}),
                  }
                : {}),
              category: category || null,
              ...(wholePair(shelfLifeAmount, shelfLifeUnit)
                ? { shelfLifeAmount: amountOf(shelfLifeAmount), shelfLifeUnit }
                : {}),
              ...(wholePair(prepTimeAmount, prepTimeUnit)
                ? { prepTimeAmount: amountOf(prepTimeAmount), prepTimeUnit }
                : {}),
              autoSumYieldEnabled,
              autoPrepTimeEnabled,
              percentageMode,
              percentIngredientEnabled,
              percentIngredientType,
              items: normalizedItems,
              steps: normalizedSteps,
              // The wire wants the original alongside whatever the cook
              // keeps; an empty list still means "no custom batches".
              batchSizes:
                customBatches.length > 0
                  ? [
                      { label: "1x", scale: 1, isOriginal: true },
                      ...customBatches.map(({ label, scale }) => ({
                        label,
                        scale,
                        isOriginal: false,
                      })),
                    ]
                  : [],
              equivalency: equivalency ? equivalencyPayload(equivalency) : null,
              tags,
            }
          : {
              id: recipeIdRef.current,
              ...(expectedEditVersion === null ? {} : { expectedEditVersion }),
              title: name,
              description,
              items: normalizedItems,
              steps: normalizedSteps,
            }
      )
      if ("error" in profile) {
        if (creating) recipeLimit.show(profile)
        return toSaveFailure(profile)
      }
      const id = profile.id
      recipeIdRef.current = id
      setRecipeId(id)
      // Adopt the sub-recipe payloads the server stored: a line linked in this
      // session has none, and without them the row cannot expand until a
      // reload.
      const linked = new Map(
        (profile.items ?? []).flatMap((row) =>
          row.subrecipeId && row.subrecipe
            ? ([[row.subrecipeId, row.subrecipe]] as const)
            : []
        )
      )
      // The breadcrumb and tabs are the chrome's, rendered from what the
      // server said when the page opened; every save tells it what changed.
      setSaved({ id, publicId: profile.publicId, title: name })
      // The URL follows only once nothing is unsaved, so a reload lands on
      // exactly what is on screen. Leaving: rewrite it at once, never navigate.
      if (creating) {
        const url = `/recipes/${profile.publicId}/recipe`
        if (leaving) window.history.replaceState(null, "", url)
        else pendingUrl.current = url
      }
      return {
        editVersion: profile.editVersion,
        adopt:
          linked.size > 0
            ? () =>
                setItems((current) =>
                  current.map((item) =>
                    item.subrecipeId &&
                    !item.subrecipe &&
                    linked.has(item.subrecipeId)
                      ? {
                          ...item,
                          subrecipe: linked.get(item.subrecipeId) ?? null,
                        }
                      : item
                  )
                )
            : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const named = items.find(
        (item) =>
          item.displayName.trim() &&
          message.startsWith(`${item.displayName.trim()} `)
      )
      setInvalidKey(named?.key ?? null)
      return toSaveFailure(error)
    }
  }

  // A brand new recipe is not worth a row until it holds something: a name,
  // or a line the cook typed before naming it.
  const worthKeeping =
    title.trim() !== "" || items.length > 0 || steps.length > 0
  const { saveNow, conflict, restorable, dismissRestore, discardDraft } =
    useDocumentSave({
      snapshot,
      active: canEdit && dirty && (recipeId !== null || worthKeeping),
      // A new recipe with a line saves at once: Cost, Nutrition and Share all
      // need the row to exist. A name alone waits for the quiet spell.
      immediate: recipeId === null && (items.length > 0 || steps.length > 0),
      wholeForm,
      kind: "recipe",
      workspaceId: initial?.userId ?? currentUserId,
      userId: currentUserId,
      recordId: recipeId,
      editVersion: initial?.editVersion ?? null,
      payload: () =>
        recipeDraft({
          title,
          description,
          items,
          steps,
          batchSizes: customBatches,
          equivalency,
          tags,
        }),
      setDirty,
      setSaveState,
      save,
    })

  // The URL a created recipe belongs at, swapped in only when the screen is
  // quiet. Next reads the swap as a restore of the tree already on screen:
  // nothing is fetched and nothing remounts. Nothing on this screen may ask
  // the router to refresh after it, though: a refresh fetches the route at
  // the new URL, which is a different tree, and rebuilds the screen from the
  // server with the cursor and anything typed meanwhile gone.
  const pendingUrl = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!pendingUrl.current || dirty || saveState !== "saved") return
    window.history.replaceState(null, "", pendingUrl.current)
    pendingUrl.current = null
  })

  // After the commit, so the save sends the line the cook just picked rather
  // than the one it replaced.
  const saveOnLink = React.useRef(false)
  React.useEffect(() => {
    if (!saveOnLink.current) return
    saveOnLink.current = false
    void saveNow()
  })

  /** The same save, out loud: the header's Save button and Enter in the form. */
  const saveOnRequest = async () => {
    const failure = await saveNow()
    if (!failure) {
      toast.add({ title: "Recipe saved" })
      return
    }
    toast.add({
      title: "Couldn’t save",
      description: failure.message,
      type: "error",
    })
  }

  // The Save button lives in the chrome, above this screen; it calls this.
  // Leaving the page calls the silent one: a save that lands is the answer to
  // "you have unsaved changes", and only a save that fails has to ask.
  // Registered once through a ref: re-registering on every render toggles
  // state in the chrome, and a fast enough run of keystrokes chains those
  // updates past React's nested-update limit.
  const saveOnRequestRef = React.useRef(saveOnRequest)
  React.useEffect(() => {
    saveOnRequestRef.current = saveOnRequest
  })
  React.useEffect(() => {
    // A viewer registers nothing, so the header draws no Save it would only
    // refuse.
    registerSave(canEdit ? () => saveOnRequestRef.current() : null)
    importRef.current = () => setImportPart("recipe")
    return () => {
      registerSave(null)
      importRef.current = null
    }
  }, [canEdit, registerSave, importRef])
  // Any batch is a lens: what is typed at 2x is stored at 1x.
  const scaled = batch.scale !== 1

  // "Auto-calculate total yield": the batch weighs what went into it. The
  // switch is only worth offering once there is something to weigh.
  const hasMeasuredLines = items.some(
    (item) => item.kind === "ingredient" || item.kind === "subrecipe"
  )
  // The yield's unit decides what every line has to become. A blank automatic
  // yield starts in grams; the cook can still choose volume or count instead.
  const autoYieldUnit = yieldUnit || "g"
  const weighed = React.useMemo(
    () => weighRecipeLines(items, sources, autoYieldUnit),
    [autoYieldUnit, items, sources]
  )
  // What the batch weighs: every line a conversion can put on the scale,
  // added up under the table, with the lines it cannot weigh counted out
  // loud rather than silently missing from the figure.
  const batchWeight = React.useMemo(() => {
    const declared = batchAmountIn(
      {
        id: recipeId ?? "draft",
        yieldAmount: Number(yieldAmount) || null,
        yieldUnit,
        equivalency: equivalency ? equivalencyPayload(equivalency) : null,
      },
      "mass"
    )
    if (declared !== null) return { grams: declared, missing: [] as string[] }

    const inGrams = weighRecipeLines(items, sources, "g")
    let grams = 0
    let weighedCount = 0
    const missing: string[] = []
    for (const [index, line] of inGrams.lines.entries()) {
      if (line.grams !== null) {
        grams += line.grams
        weighedCount += 1
      } else if (line.reason !== null) {
        missing.push(items[index]?.displayName.trim() || "Unnamed line")
      }
    }
    if (weighedCount === 0) return null
    return { grams, missing }
  }, [equivalency, items, recipeId, sources, yieldAmount, yieldUnit])
  const autoCalculating = owner && autoSumYieldEnabled && hasMeasuredLines
  const autoYield = React.useMemo(() => {
    if (!autoCalculating || weighed.total === null) return ""
    const converted =
      weighed.family === "count"
        ? weighed.total
        : convertAmount(
            weighed.total,
            weighed.family === "volume" ? "ml" : "g",
            autoYieldUnit
          )
    // A sum of estimates is not worth six decimals: 715.65 g reads as a
    // yield, 715.65101 reads as a mistake.
    return converted === null
      ? ""
      : clampRecipeQuantity(Math.round(converted * 100) / 100)
  }, [autoCalculating, autoYieldUnit, weighed])
  // The sum is the recipe's yield, so it has to reach the state Save, the Cost
  // tab and the batch calculator all read. Reconciling here rather than in an
  // effect keeps one render authoritative and leaves the number behind when
  // the switch goes off. Null until the first sum, so a recipe that opens with
  // the switch already on adopts today's sum rather than yesterday's number.
  const [appliedAutoYield, setAppliedAutoYield] = React.useState<string | null>(
    null
  )
  if (autoYield !== appliedAutoYield) {
    setAppliedAutoYield(autoYield)
    if (autoCalculating) setYieldAmount(autoYield)
  }
  const autoYieldHint =
    autoCalculating && weighed.total === null
      ? `Link every ingredient and give each one a conversion to ${unitWord(countedAsEach(autoYieldUnit))} to auto-calculate.`
      : null
  // "Auto-calculate from steps": the method already says how long a batch
  // takes, so the active steps that carry a time add up to the prep time.
  const stepLaborSeconds = React.useMemo(() => {
    const timed = steps
      .filter((step) => step.laborKind === "active")
      .map((step) =>
        observedSecondsForBatch({
          id: step.key,
          kind: "active",
          timings: step.timings.map((timing) => ({
            seconds: Number(timing.seconds || 0),
            yieldCount: Number(timing.yieldCount || 1),
          })),
        })
      )
      .filter((seconds): seconds is number => seconds !== null)
    return timed.length === 0
      ? null
      : timed.reduce((total, seconds) => total + seconds, 0)
  }, [steps])
  const autoPrepSeconds = autoPrepTimeEnabled ? stepLaborSeconds : null
  const autoPrepAmount =
    autoPrepSeconds === null
      ? ""
      : prepTimeAmountOf(autoPrepSeconds, prepTimeUnit)
  // The same reconcile the yield gets: the sum has to reach the state Save
  // sends, and leave its number behind when the switch goes off.
  const [appliedAutoPrep, setAppliedAutoPrep] = React.useState<string | null>(
    null
  )
  if (autoPrepAmount !== appliedAutoPrep) {
    setAppliedAutoPrep(autoPrepAmount)
    if (autoPrepTimeEnabled) setPrepTimeAmount(autoPrepAmount)
  }
  // Only while the switch is on: the rest of the time an unweighable line is
  // nobody's problem.
  const weighAlerts = React.useMemo(() => {
    if (!autoCalculating) return undefined
    const alerts: Record<string, string> = {}
    items.forEach((item, index) => {
      const label = weighReasonLabel(
        weighed.lines[index]?.reason ?? null,
        item.unit,
        autoYieldUnit,
        item.displayName
      )
      if (label) alerts[item.key] = label
    })
    return alerts
  }, [autoCalculating, autoYieldUnit, items, weighed.lines])
  const canEditHere = canEdit
  /**
   * Rewrite the recipe at a factor: every amount and the yield, so what the
   * cook sees at that batch becomes the recipe itself.
   */
  const rewriteAt = (factor: number) => {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return
    setItems((current) =>
      current.map((item) =>
        item.quantity && Number.isFinite(Number(item.quantity))
          ? {
              ...item,
              quantity: clampRecipeQuantity(Number(item.quantity) * factor),
            }
          : item
      )
    )
    if (Number(yieldAmount) > 0) {
      setYieldAmount(clampRecipeQuantity(Number(yieldAmount) * factor))
    }
    // The screen keeps showing the same numbers; they are now the recipe.
    setBatch(ORIGINAL_BATCH)
  }
  const addItem = (
    itemKind: ItemKind,
    partial?: Partial<ItemState>,
    afterKey?: string | null
  ) => {
    const itemKey = key()
    const row: ItemState = {
      key: itemKey,
      kind: itemKind,
      displayName: "",
      quantity:
        itemKind === "ingredient" || itemKind === "subrecipe" ? "1" : "",
      unit: itemKind === "ingredient" || itemKind === "subrecipe" ? "each" : "",
      preparationNote: "",
      efficiency: "100",
      efficiencyAfterCooking: "100",
      isBase: false,
      excludedFromCost: false,
      ingredientId: null,
      subrecipeId: null,
      ...partial,
    }
    setItems((current) => {
      const at = afterKey
        ? current.findIndex((item) => item.key === afterKey)
        : -1
      if (at === -1) return [...current, row]
      return [...current.slice(0, at + 1), row, ...current.slice(at + 1)]
    })
    return itemKey
  }
  /**
   * A pasted list, linked the way the picker links a line the cook types:
   * their pantry first, then their own recipes, then the open catalog. A name
   * none of those answer stays as written, which the table flags in amber.
   */
  const applyImportedItems = async (text: string) => {
    const parsed = parseRecipeText(text, {
      identities: sources.items.filter((entry) => !entry.nonEdible),
    })
    // Written order, whatever each line turned out to be: a heading
    // belongs above the rows it introduces, not at the end of the list.
    // A line nothing could read is kept as a note rather than lost.
    const written = [
      ...parsed.headerLines,
      ...parsed.noteLines,
      ...parsed.skippedLines.map((line) => ({
        kind: "note" as const,
        lineNumber: line.lineNumber,
        text: line.rawLine.trim(),
      })),
      ...parsed.parsedLines,
    ].sort((left, right) => left.lineNumber - right.lineNumber)
    // Grows as catalog picks land in the pantry, so a second line naming the
    // same ingredient links to the row the first one created. Supplies are
    // not on it: a pasted line names food.
    const pantry = ingredientTargets.filter((one) => !one.nonEdible)
    const added: ItemState[] = []
    for (const line of written) {
      if (line.kind !== "ingredient") {
        added.push({
          key: key(),
          kind: line.kind as ItemKind,
          displayName: line.text,
          quantity: "",
          unit: "",
          preparationNote: "",
          efficiency: "100",
          efficiencyAfterCooking: "100",
          isBase: false,
          excludedFromCost: false,
          ingredientId: null,
          subrecipeId: null,
        })
        continue
      }
      const resolved = await resolveLine(line, {
        ingredients: pantry,
        recipes: recipeTargets.filter((one) => one.id !== recipeId),
        searchCatalog: searchCatalogIngredients,
        activateCatalog: activateCatalogIngredient,
      })
      const activated = resolved?.activated
      if (activated) {
        pantry.push(activated)
        setActivated((current) =>
          current.some((one) => one.id === activated.id)
            ? current
            : [...current, activated]
        )
      }
      added.push({
        key: key(),
        kind: "ingredient" as ItemKind,
        displayName: line.baseName,
        // An unmeasured line has no amount to write down; the row
        // waits for one instead of claiming zero.
        quantity:
          line.alert === "unmeasured"
            ? ""
            : clampRecipeQuantity(line.enteredAmount),
        unit:
          line.normalizedUnit === "assumed-g"
            ? "g"
            : line.alert === "unmeasured"
              ? (line.normalizedUnit ?? "")
              : line.normalizedUnit || "each",
        preparationNote: line.noteText ?? "",
        efficiency: "100",
        efficiencyAfterCooking: "100",
        isBase: false,
        excludedFromCost: false,
        ingredientId: null,
        subrecipeId: null,
        ...resolved?.patch,
      })
    }
    setItems((current) => [...current, ...added])
  }

  const stepsRef = React.useRef<HTMLDivElement>(null)
  useSortableRows(stepsRef, canEdit, (fromIndex, toIndex) =>
    setSteps((current) => {
      const next = [...current]
      const [moved] = next.splice(fromIndex, 1)
      if (!moved) return current
      next.splice(toIndex, 0, moved)
      return next
    })
  )
  const patchItem = (itemKey: string, patch: Partial<ItemState>) => {
    if (itemKey === invalidKey) setInvalidKey(null)
    // A link is a decision, not typing: it is dirty at once, so leaving now
    // has something to stop, and it saves without waiting out the quiet spell.
    if ("ingredientId" in patch || "subrecipeId" in patch) {
      setDirty(true)
      saveOnLink.current = true
    }
    setItems((current) =>
      current.map((item) =>
        item.key === itemKey ? { ...item, ...patch } : item
      )
    )
  }
  const patchStep = (stepKey: string, patch: Partial<StepState>) =>
    setSteps((current) =>
      current.map((step) =>
        step.key === stepKey ? { ...step, ...patch } : step
      )
    )
  /** The dialog edits one time in the cook's unit; the step stores seconds. */
  const openLabor = (step: StepState) => {
    const seconds = Number(step.timings[0]?.seconds ?? 0)
    const unit = prepTimeUnitFor(seconds > 0 ? seconds : null)
    setLaborTime({
      amount: seconds > 0 ? prepTimeAmountOf(seconds, unit) : "",
      unit,
    })
    setLaborKey(step.key)
  }
  const patchLaborTime = (stepKey: string, amount: string, unit: string) => {
    setLaborTime({ amount, unit })
    const seconds = Math.round(Number(amount || 0) * prepTimeDivisor(unit))
    // A step with a time is hands-on work; blank means none.
    patchStep(stepKey, {
      laborKind: seconds > 0 ? "active" : "",
      timings:
        seconds > 0 ? [{ seconds: String(seconds), yieldCount: "1" }] : [],
    })
  }
  // A custom batch is a display lens. Equivalencies describe the whole batch,
  // so their amounts scale with it; the portion remains one serving.
  const atViewedBatch = (amount: string) =>
    scaled && Number(amount) > 0
      ? clampRecipeQuantity(Number(amount) * batch.scale)
      : amount
  const atOriginalBatch = (amount: string) =>
    scaled && Number(amount) > 0
      ? clampRecipeQuantity(Number(amount) / batch.scale)
      : amount
  const declaredYield =
    Number(yieldAmount) > 0 && yieldFamily(yieldUnit)
      ? {
          amount: atViewedBatch(yieldAmount),
          unit: yieldUnit === "pcs" ? "each" : yieldUnit,
          field:
            yieldFamily(yieldUnit) === "mass"
              ? ("weight" as const)
              : yieldFamily(yieldUnit) === "volume"
                ? ("volume" as const)
                : ("each" as const),
        }
      : null
  const lockedYield =
    declaredYield && equivalency?.standard !== true ? declaredYield : null
  const equivalencyFields = {
    weight: {
      amount:
        lockedYield?.field === "weight"
          ? lockedYield.amount
          : atViewedBatch(equivalency?.massAmount ?? ""),
      unit:
        lockedYield?.field === "weight"
          ? lockedYield.unit
          : (equivalency?.massUnit ?? "g"),
    },
    volume: {
      amount:
        lockedYield?.field === "volume"
          ? lockedYield.amount
          : atViewedBatch(equivalency?.volumeAmount ?? ""),
      unit:
        lockedYield?.field === "volume"
          ? lockedYield.unit
          : (equivalency?.volumeUnit ?? "cup"),
    },
    each: {
      amount:
        lockedYield?.field === "each"
          ? lockedYield.amount
          : atViewedBatch(equivalency?.countAmount ?? ""),
      unit:
        lockedYield?.field === "each"
          ? lockedYield.unit
          : (equivalency?.countUnit ?? "each"),
    },
  }
  const patchEquivalency = (patch: Partial<NonNullable<typeof equivalency>>) =>
    setEquivalency((current) => ({
      massAmount: "",
      massUnit: "g",
      volumeAmount: "",
      volumeUnit: "cup",
      countAmount: "",
      countUnit: "each",
      standard: true,
      ...current,
      ...patch,
    }))

  const laborStep = steps.find((step) => step.key === laborKey) ?? null

  /** Put a recovered draft back on the screen, field for field. */
  const applyRecovery = (recovery: RecipeRecovery) => {
    setTitle(recovery.title)
    setDescription(recovery.description)
    setItems(recovery.items)
    setSteps(recovery.steps)
    setCustomBatches(recovery.batchSizes)
    setEquivalency(recovery.equivalency)
    setTags(recovery.tags)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void saveOnRequest()
      }}
      className="grid w-full max-w-[1180px] gap-8 pb-16"
      aria-label="Recipe"
    >
      <div className="grid min-w-0 gap-8">
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
                applyRecovery(restorable as RecipeRecovery)
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
        <Section>
          <div className="grid gap-3">
            <LabeledInput
              ref={titleRef}
              label="Name (required)"
              value={title}
              disabled={!canEdit}
              readOnly={!hydrated}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                // Leaving the name commits it, the way a Save press would.
                if (dirty && worthKeeping) void saveNow()
              }}
            />
            <LabeledInput
              label="Description"
              value={description}
              disabled={!canEdit}
              readOnly={!hydrated}
              onChange={(event) => setDescription(event.target.value)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <LabeledShell label="Status">
                <OptionSelect
                  label="Status"
                  value={status}
                  disabled={!owner}
                  onChange={(value) => setStatus(value as RecipeStatus)}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                  ]}
                />
              </LabeledShell>
              <LabeledShell label="Category">
                <CategoryCombobox
                  value={category}
                  disabled={!owner}
                  onChange={setCategory}
                  options={categoryOptions}
                />
              </LabeledShell>
            </div>
          </div>
        </Section>

        <Section title="Total yield">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <div id="recipe-batch-size">
                <Field label="Batch size">
                  <BatchSizeSelect
                    value={batch}
                    onChange={setBatch}
                    onCustom={() => setCustomOpen(true)}
                    saved={customBatches}
                    onRemove={
                      owner
                        ? (size) => {
                            setCustomBatches((current) =>
                              current.filter((one) => !sameBatch(one, size))
                            )
                            if (sameBatch(batch, size)) setBatch(ORIGINAL_BATCH)
                          }
                        : undefined
                    }
                  />
                </Field>
              </div>
              <HintLine />
            </div>
            <div className="grid gap-2">
              <Field label="Total yield">
                <MeasureField
                  amountReadOnly={!hydrated}
                  label="Total yield"
                  amount={
                    autoCalculating && !autoYield
                      ? ""
                      : scaled && Number(yieldAmount) > 0
                        ? clampRecipeQuantity(Number(yieldAmount) * batch.scale)
                        : yieldAmount
                  }
                  unit={yieldUnit || null}
                  options={YIELD_UNIT_OPTIONS}
                  disabled={!owner}
                  amountDisabled={autoCalculating}
                  onAmountChange={(next) =>
                    setYieldAmount(
                      scaled && Number(next) > 0
                        ? clampRecipeQuantity(Number(next) / batch.scale)
                        : next
                    )
                  }
                  onUnitChange={(unit) => setYieldUnit(unit ?? "")}
                />
              </Field>
              <HintLine error>
                {pairIncomplete(yieldAmount, yieldUnit)
                  ? "Pick a unit to save this"
                  : null}
              </HintLine>
            </div>
          </div>
          {owner ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <label className="mt-4 flex h-9 w-fit items-center gap-3 text-sm font-medium text-foreground">
                      <Switch
                        checked={autoSumYieldEnabled}
                        disabled={!hasMeasuredLines}
                        onCheckedChange={(on) => {
                          // Off brings back the number the cook had typed
                          // before the sum took the field over, like a revert.
                          if (on) {
                            typedYieldRef.current = yieldAmount
                            if (!yieldUnit) setYieldUnit("g")
                          } else if (typedYieldRef.current !== null) {
                            setYieldAmount(typedYieldRef.current)
                            typedYieldRef.current = null
                          }
                          setAutoSumYieldEnabled(on)
                        }}
                      />
                      Auto-calculate total yield
                    </label>
                  }
                />
                {!hasMeasuredLines ? (
                  <TooltipContent>
                    Add a measured ingredient to use this.
                  </TooltipContent>
                ) : null}
              </Tooltip>
              {autoYieldHint ? (
                <p className="flex items-center gap-2 text-xs text-warning-foreground">
                  <TriangleAlert
                    className="size-3.5 shrink-0 text-warning"
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                  {autoYieldHint}
                </p>
              ) : null}
            </>
          ) : null}
        </Section>

        <CustomBatchDialog
          open={customOpen}
          onOpenChange={setCustomOpen}
          recipeYield={
            Number(yieldAmount) > 0 && yieldUnit
              ? { amount: Number(yieldAmount), unit: yieldUnit }
              : null
          }
          onApply={(size) => {
            setBatch(size)
            // A batch worth naming is worth keeping: it joins the menu and
            // the recipe, unless the menu already has it.
            if (
              owner &&
              !BUILT_IN_BATCHES.some((built) => sameBatch(built, size)) &&
              !customBatches.some((one) => sameBatch(one, size))
            ) {
              setCustomBatches((current) => [
                ...current,
                { label: size.label, scale: size.scale, isOriginal: false },
              ])
            }
          }}
          onRewrite={owner ? rewriteAt : undefined}
        />

        <Section
          title="Ingredients"
          action={
            batchWeight ? (
              <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                {batchWeight.missing.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          role="img"
                          aria-label={`Excluded from batch weight: ${batchWeight.missing.join(", ")}.`}
                          className="flex size-5 items-center justify-center rounded-md text-warning"
                        />
                      }
                    >
                      <TriangleAlert
                        className="size-[13px]"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {`Excluded from batch weight: ${batchWeight.missing.join(", ")}. Add a weight conversion, or set the UOM.`}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                Batch weight ≈{" "}
                {formatScaledWeight(
                  batchWeight.grams * batch.scale,
                  measurementSystem
                )}
              </span>
            ) : null
          }
        >
          <RecipeItemsTable
            items={items}
            canEdit={canEditHere}
            scale={batch.scale}
            recipeId={recipeId}
            ingredientTargets={ingredientTargets}
            onIngredientActivated={(row) =>
              setActivated((current) =>
                current.some((one) => one.id === row.id)
                  ? current
                  : [...current, row]
              )
            }
            recipeTargets={recipeTargets}
            onPatch={patchItem}
            onOpenImport={() => setImportPart("ingredients")}
            onAddSteps={(text) => {
              const added = stepsFromText(text)
              if (added.length) setSteps((current) => [...current, ...added])
            }}
            invalidKey={invalidKey}
            onReorder={(fromIndex, toIndex) =>
              setItems((current) => {
                const next = [...current]
                const [moved] = next.splice(fromIndex, 1)
                if (!moved) return current
                next.splice(toIndex, 0, moved)
                return next
              })
            }
            onRemove={(itemKey) =>
              setItems((current) =>
                current.filter((item) => item.key !== itemKey)
              )
            }
            onAdd={addItem}
            percentMode={percentIngredientEnabled}
            onPercentModeChange={(next) => {
              setPercentIngredientEnabled(next)
              setPercentageMode(
                next
                  ? percentageMode ||
                      window.localStorage.getItem(PERCENT_MODE_KEY) ||
                      "standard"
                  : ""
              )
              setPercentIngredientType(
                next ? percentIngredientType || "weight" : ""
              )
            }}
            percentageMode={percentageMode}
            onPercentageModeChange={setPercentageMode}
            weighAlerts={weighAlerts}
            onSetBase={(itemKey) =>
              setItems((current) =>
                current.map((item) => ({
                  ...item,
                  isBase: item.key === itemKey,
                }))
              )
            }
          />
        </Section>

        <Section title="Prep method">
          <div ref={stepsRef} className="grid gap-4">
            {steps.map((step, index) => (
              <div
                key={step.key}
                data-sortable-row
                className="group/row grid grid-cols-[20px_minmax(0,1fr)_60px] items-start gap-2"
              >
                {/* The number is the handle: hover it and the grip takes its place. */}
                <span className="relative pt-2 text-sm text-muted-foreground tabular-nums">
                  <span className="group-hover/row:invisible">
                    {step.kind === "instruction"
                      ? steps
                          .slice(0, index + 1)
                          .filter((one) => one.kind === "instruction").length
                      : ""}
                  </span>
                  {canEdit ? (
                    <span
                      data-drag-handle
                      aria-hidden="true"
                      className={cn(
                        dragHandleClassName,
                        "absolute top-1 left-0"
                      )}
                    >
                      <GripVertical className="size-4" />
                    </span>
                  ) : null}
                </span>
                <div className="grid gap-2">
                  {step.kind === "header" ? (
                    <Input
                      className={cn(inputClass, "font-medium")}
                      value={step.title}
                      disabled={!canEdit}
                      aria-label="Heading"
                      placeholder="Section heading"
                      onChange={(event) =>
                        patchStep(step.key, { title: event.target.value })
                      }
                    />
                  ) : (
                    <Textarea
                      className={cn(
                        "min-h-20 bg-card",
                        step.kind === "note" && "text-muted-foreground italic"
                      )}
                      value={step.body}
                      disabled={!canEdit}
                      aria-label={
                        step.kind === "note" ? "Note" : `Step ${index + 1} body`
                      }
                      placeholder={
                        step.kind === "note"
                          ? "Note"
                          : "What happens? Or # Section"
                      }
                      onChange={(event) =>
                        patchStep(step.key, { body: event.target.value })
                      }
                      onBlur={(event) => {
                        // "# Bake" typed as a step is a section heading.
                        const heading = event.target.value
                          .trim()
                          .match(HEADING_PATTERN)
                        if (heading && step.kind === "instruction") {
                          patchStep(step.key, {
                            kind: "header",
                            title: heading[1],
                            body: "",
                          })
                        }
                      }}
                    />
                  )}
                  {stepTimeLabel(step) !== "Time" ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {stepTimeLabel(step)}
                    </span>
                  ) : null}
                  {step.media.length ? (
                    <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                      {step.media.map((media) => (
                        <a
                          key={media.id}
                          href={media.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-border px-2 py-1 hover:bg-muted"
                        >
                          {media.altText || "Step media"}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  <span className="flex items-center gap-1">
                    {/* Time is the action a step gets most, so it sits in
                        the open rather than behind the menu. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Time for step ${index + 1}`}
                      title={stepTimeLabel(step)}
                      onClick={() => openLabor(step)}
                    >
                      <Timer strokeWidth={1.8} aria-hidden="true" />
                    </Button>
                    <RowActionsMenu label={`Actions for step ${index + 1}`}>
                      <MenuItem
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((row) => row.key !== step.key)
                          )
                        }
                        className="text-destructive data-highlighted:text-destructive"
                      >
                        <Trash2
                          className="text-current"
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                        Remove
                      </MenuItem>
                    </RowActionsMenu>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {canEdit ? (
            <>
              <AddButton
                className="mt-2"
                onClick={() => setImportPart("method")}
              />
            </>
          ) : null}
        </Section>

        {owner ? (
          <Section title="Additional details">
            <div className="grid gap-6">
              <div className="flex flex-wrap gap-6">
                <div className="grid gap-2">
                  <Field label="Shelf life">
                    <MeasureField
                      label="Shelf life"
                      className="w-56"
                      amount={shelfLifeAmount}
                      unit={shelfLifeUnit || null}
                      options={SHELF_LIFE_UNITS}
                      onAmountChange={setShelfLifeAmount}
                      onUnitChange={(unit) => setShelfLifeUnit(unit ?? "")}
                    />
                  </Field>
                  <HintLine error>
                    {pairIncomplete(shelfLifeAmount, shelfLifeUnit)
                      ? "Pick a unit to save this"
                      : null}
                  </HintLine>
                </div>
                <div className="grid gap-2">
                  <Field label="Prep time">
                    <MeasureField
                      label="Prep time"
                      className="w-56"
                      amount={
                        autoPrepTimeEnabled ? autoPrepAmount : prepTimeAmount
                      }
                      unit={prepTimeUnit || null}
                      options={PREP_TIME_UNITS}
                      amountDisabled={autoPrepTimeEnabled}
                      onAmountChange={setPrepTimeAmount}
                      onUnitChange={(unit) => setPrepTimeUnit(unit ?? "")}
                    />
                  </Field>
                  <HintLine error>
                    {pairIncomplete(prepTimeAmount, prepTimeUnit)
                      ? "Pick a unit to save this"
                      : null}
                  </HintLine>
                </div>
              </div>
              <div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <label className="flex h-9 w-fit items-center gap-3 text-sm font-medium text-foreground">
                        <Switch
                          checked={autoPrepTimeEnabled}
                          disabled={stepLaborSeconds === null}
                          onCheckedChange={(on) => {
                            // Off brings back the number the cook had typed
                            // before the steps took the field over, like a revert.
                            if (on) {
                              typedPrepRef.current = prepTimeAmount
                              setPrepTimeUnit(prepTimeUnitFor(stepLaborSeconds))
                            } else if (typedPrepRef.current !== null) {
                              setPrepTimeAmount(typedPrepRef.current)
                              typedPrepRef.current = null
                            }
                            setAutoPrepTimeEnabled(on)
                          }}
                        />
                        Auto-calculate from steps
                      </label>
                    }
                  />
                  {stepLaborSeconds === null ? (
                    <TooltipContent>
                      Add a timed active step to use this.
                    </TooltipContent>
                  ) : null}
                </Tooltip>
              </div>
              <div className="grid gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <h3
                      id="uom-equivalency"
                      tabIndex={-1}
                      className="scroll-mt-6 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      UOM
                    </h3>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Info
                            className="size-[14px] shrink-0 text-muted-foreground"
                            strokeWidth={1.8}
                            role="img"
                            aria-label="What the batch UOM means"
                          />
                        }
                      />
                      <TooltipContent className="max-w-[280px]">
                        {equivalency?.standard
                          ? "This standard weight–volume ratio scales with Total Yield."
                          : "Express the entire finished batch in another unit. This does not set the portion size."}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {declaredYield ? (
                    <span className="text-xs text-muted-foreground">
                      Yield: {formatKitchenAmount(Number(declaredYield.amount))}{" "}
                      {declaredYield.unit === "cup"
                        ? "cup"
                        : unitShort(declaredYield.unit)}
                    </span>
                  ) : null}
                </div>
                <UnitConversionFields
                  idPrefix="equivalency"
                  values={equivalencyFields}
                  options={CONVERSION_UNITS}
                  disabled={!canEdit}
                  locked={lockedYield ? { [lockedYield.field]: true } : {}}
                  onChange={(next) =>
                    patchEquivalency({
                      massAmount:
                        lockedYield?.field === "weight"
                          ? (equivalency?.massAmount ?? "")
                          : atOriginalBatch(next.weight.amount),
                      massUnit:
                        lockedYield?.field === "weight"
                          ? (equivalency?.massUnit ?? "g")
                          : (next.weight.unit ?? "g"),
                      volumeAmount:
                        lockedYield?.field === "volume"
                          ? (equivalency?.volumeAmount ?? "")
                          : atOriginalBatch(next.volume.amount),
                      volumeUnit:
                        lockedYield?.field === "volume"
                          ? (equivalency?.volumeUnit ?? "cup")
                          : (next.volume.unit ?? "cup"),
                      countAmount:
                        lockedYield?.field === "each"
                          ? (equivalency?.countAmount ?? "")
                          : atOriginalBatch(next.each.amount),
                      countUnit:
                        lockedYield?.field === "each"
                          ? (equivalency?.countUnit ?? "each")
                          : (next.each.unit ?? "each"),
                      // What it happens to be, not a switch: once a cook types
                      // their own figure it is no longer the standard one.
                      standard: false,
                    })
                  }
                />
              </div>
            </div>
          </Section>
        ) : null}

        {owner ? (
          <Section>
            <IngredientTagsCard
              options={tagOptions}
              value={tags}
              onChange={setTags}
            />
          </Section>
        ) : null}

        {owner && initial ? (
          <Section
            title={
              <span className="flex items-center gap-1.5">
                Used in
                {usedInRows.length > 0 ? (
                  <span className="text-sm font-normal text-muted-foreground tabular-nums">
                    {usedInRows.length}
                  </span>
                ) : null}
              </span>
            }
          >
            <UsedInList rows={usedInRows} />
          </Section>
        ) : null}

        {initial ? (
          <Section title="Comments">
            <div className="grid gap-3">
              {initial.comments.map((comment) => (
                <div
                  key={comment.id}
                  className="group/row rounded-lg bg-muted/50 p-3"
                >
                  <div className="flex items-center justify-between gap-3 text-xs leading-4 text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {comment.authorName}
                    </span>
                    <span className="flex items-center gap-2">
                      {formatFullDate(comment.createdAt, timezone)}
                      {owner || comment.authorId === currentUserId ? (
                        <button
                          type="button"
                          aria-label="Remove comment"
                          disabled={commentBusy !== null}
                          className={cn(
                            "flex size-6 items-center justify-center rounded-md text-disabled-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100",
                            commentBusy === comment.id && "opacity-100"
                          )}
                          onClick={async () => {
                            setCommentBusy(comment.id)
                            try {
                              notifyError(await deleteRecipeComment(comment.id))
                            } finally {
                              setCommentBusy(null)
                            }
                          }}
                        >
                          {commentBusy === comment.id ? (
                            <Spinner size="sm" label="Removing" />
                          ) : (
                            <X
                              className="size-3.5"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-1 text-md leading-5 whitespace-pre-wrap">
                    {comment.body}
                  </p>
                </div>
              ))}
              {canEdit ? (
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Textarea
                      className="min-h-16 w-full bg-card"
                      value={commentDraft}
                      aria-label="Comment"
                      placeholder="Leave a note for the team"
                      onChange={(event) => {
                        setCommentDraft(event.target.value)
                        setCommentError(null)
                      }}
                    />
                    {commentError ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {commentError}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    className="self-end"
                    variant="outline"
                    pending={commentBusy === "new"}
                    onClick={async () => {
                      if (!commentDraft.trim()) {
                        setCommentError("Write a comment first.")
                        return
                      }
                      setCommentBusy("new")
                      try {
                        const result = await saveRecipeComment({
                          recipeId: initial.id,
                          body: commentDraft,
                        })
                        notifyError(result)
                        if (!("error" in result)) setCommentDraft("")
                      } finally {
                        setCommentBusy(null)
                      }
                    }}
                  >
                    Comment
                  </Button>
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {recipeLimit.dialog}

        <ImportRecipeDialog
          open={importPart !== null}
          part={importPart ?? "recipe"}
          onOpenChange={(next) => !next && setImportPart(null)}
          onApply={(text, method) => {
            const added = stepsFromText(method)
            if (added.length) setSteps((current) => [...current, ...added])
            if (!text.trim()) return
            void applyImportedItems(text)
          }}
        />

        <Dialog
          open={laborStep !== null}
          onOpenChange={(next) => !next && setLaborKey(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Time</DialogTitle>
            </DialogHeader>
            {laborStep ? (
              <Field label="Time">
                <MeasureField
                  label="Time"
                  amount={laborTime.amount}
                  unit={laborTime.unit}
                  options={PREP_TIME_UNITS}
                  disabled={!owner}
                  onAmountChange={(amount) =>
                    patchLaborTime(laborStep.key, amount, laborTime.unit)
                  }
                  onUnitChange={(unit) =>
                    patchLaborTime(
                      laborStep.key,
                      laborTime.amount,
                      unit ?? "minutes"
                    )
                  }
                />
              </Field>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLaborKey(null)}
              >
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </form>
  )
}
