"use client"

import { Check, X } from "lucide-react"
import * as React from "react"

import {
  clearIngredientNutrition,
  replaceIngredientAllergens,
  setIngredientNutrition,
  updateIngredientNutritionSettings,
  type NutritionFoodMatch,
} from "@/app/(app)/ingredients/actions"
import {
  AllergenChips,
  type AllergenRow,
} from "@/components/nutrition/allergen-chips"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { RequestCustomNutritionDialog } from "@/components/nutrition/request-custom-nutrition-dialog"
import {
  UsdaFoodCombobox,
  type LinkedNutrition,
} from "@/components/nutrition/usda-food-combobox"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SaveStatusState } from "@/components/ui/save-status"
import { useToast } from "@/components/ui/toast"
import { useCommit, type Commit } from "@/hooks/use-commit"
import type { AllergenHints, IngredientDetail } from "@/lib/backend/types"
import {
  ALLERGENS,
  allergenLabel,
  type AllergenKey,
  type AllergenStatus,
} from "@/lib/nutrition/allergens"
import { CUSTOM_NUTRITION_FIELDS } from "@/lib/nutrition/custom-values"
import { formatAmount } from "@/lib/nutrition/label"
import { useDialogTarget } from "@/components/ui/dialog"

function SentRequestValues({
  request,
}: {
  request: NonNullable<IngredientDetail["nutritionRequest"]>
}) {
  const stated = CUSTOM_NUTRITION_FIELDS.filter(
    (field) => request.values[field.key] !== null
  )
  return (
    <div className="flex flex-col gap-1">
      <FieldDescription>
        {request.source ? `${request.source} — ` : ""}sent per{" "}
        {formatAmount(request.servingGrams)} g
      </FieldDescription>
      <dl className="grid grid-cols-2 gap-x-4 text-xs text-muted-foreground">
        {stated.map((field) => (
          <div key={field.key} className="flex justify-between gap-2 py-0.5">
            <dt>{field.label}</dt>
            <dd className="text-foreground">
              {formatAmount(request.values[field.key] as number)} {field.unit}
            </dd>
          </div>
        ))}
      </dl>
      {request.note ? (
        <FieldDescription>Note: {request.note}</FieldDescription>
      ) : null}
    </div>
  )
}

type Selection = { contains: Set<string>; mayContain: Set<string> }

function selectionFrom(
  allergens: IngredientDetail["effectiveAllergens"]
): Selection {
  return {
    contains: new Set(
      allergens.filter((a) => a.status === "contains").map((a) => a.key)
    ),
    mayContain: new Set(
      allergens.filter((a) => a.status === "mayContain").map((a) => a.key)
    ),
  }
}

/**
 * The full override list a selection stands for. Every selected tag is
 * stated; a deselected tag is stated "does not contain" only where the
 * ingredient's effective status says otherwise, so a catalog default is
 * masked rather than silently kept, and a tag the catalog never mentioned
 * sends nothing. A dismissed hint is the exception: it is always stated, so
 * the suggestion stops coming back.
 */
export function allergenOverrides(
  selection: Selection,
  effective: IngredientDetail["effectiveAllergens"],
  dismissed?: AllergenKey
): { key: AllergenKey; status: AllergenStatus }[] {
  const byKey = new Map(effective.map((entry) => [entry.key, entry]))
  const overrides: { key: AllergenKey; status: AllergenStatus }[] = []
  for (const { key } of ALLERGENS) {
    if (selection.contains.has(key)) overrides.push({ key, status: "contains" })
    else if (selection.mayContain.has(key))
      overrides.push({ key, status: "mayContain" })
    else {
      const current = byKey.get(key)
      if (
        key === dismissed ||
        (current &&
          (current.status !== "doesNotContain" || current.source === "user"))
      )
        overrides.push({ key, status: "doesNotContain" })
    }
  }
  return overrides
}

/** The hint lists with one tag taken out, whichever list it sat in. */
function withoutHint(hints: AllergenHints, key: string): AllergenHints {
  return {
    contains: hints.contains.filter((entry) => entry !== key),
    mayContain: hints.mayContain.filter((entry) => entry !== key),
    checkLabel: hints.checkLabel.filter((entry) => entry !== key),
  }
}

const HINT_HELP =
  "Suggestions, not facts. Confirm what your brand's label says."

/**
 * One row of unconfirmed tags. Pressing a chip confirms it into an allergen
 * row; the X beside it says the user's brand does not have it.
 */
function AllergenHintRow({
  label,
  keys,
  onConfirm,
  onDismiss,
}: {
  label: string
  keys: readonly string[]
  onConfirm: (key: string) => void
  onDismiss: (key: string) => void
}) {
  if (keys.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <span
            key={key}
            className="inline-flex h-5 items-center rounded-full border border-dashed border-line-strong bg-card"
          >
            <button
              type="button"
              aria-label={`Confirm ${allergenLabel(key)}`}
              onClick={() => onConfirm(key)}
              className="inline-flex h-5 items-center gap-1 rounded-full pr-1 pl-2 text-2xs font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              {allergenLabel(key)}
              <Check className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Not in mine: ${allergenLabel(key)}`}
              onClick={() => onDismiss(key)}
              className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Everything the label reads off one ingredient: its nutrition record, the
 * name it prints under, whether it is food at all, whether its sugars count
 * as added, and its allergen tags. Every control saves itself.
 */
export function IngredientNutritionFields({
  ingredient,
  saveRef,
  onDirtyChange,
  onSaveState,
  onSaved,
}: {
  ingredient: IngredientDetail
  /** A header's Save and Cmd+S flush the label name through here. */
  saveRef?: React.RefObject<(() => Promise<unknown>) | null>
  /** A typed label name is unsaved work: the header says Draft. */
  onDirtyChange?: (dirty: boolean) => void
  /** Mirrors what the commits are doing, for a header's pill. */
  onSaveState?: (state: SaveStatusState) => void
  /** After any successful save, so the screen can refetch what depends on it. */
  onSaved?: () => void
}) {
  const toast = useToast()
  const { labelRegion } = useBusinessSettings()
  const [nutrition, setNutrition] = React.useState<LinkedNutrition | null>(
    ingredient.nutrition
      ? {
          source: ingredient.nutrition.source,
          description: ingredient.nutrition.description,
        }
      : null
  )
  const [labelName, setLabelName] = React.useState(
    ingredient.nutritionLabelName
  )
  // What the server last accepted, so blurring an unchanged field is quiet.
  const [savedLabelName, setSavedLabelName] = React.useState(
    ingredient.nutritionLabelName
  )
  const [nonEdible, setNonEdible] = React.useState(ingredient.nonEdible)
  const [sugarsAreAdded, setSugarsAreAdded] = React.useState(
    ingredient.sugarsAreAdded
  )
  const [selection, setSelection] = React.useState<Selection>(() =>
    selectionFrom(ingredient.effectiveAllergens)
  )
  const [hints, setHints] = React.useState<AllergenHints>(
    ingredient.allergenHints
  )
  const [packageOpen, setPackageOpen] = React.useState(false)
  const [requestOpen, setRequestOpen] = React.useState(false)
  const requestShown = useDialogTarget(requestOpen ? true : null)
  const [requestPending, setRequestPending] = React.useState(
    ingredient.nutritionRequest?.status === "pending"
  )
  const [sentOpen, setSentOpen] = React.useState(false)
  const sentRequest =
    ingredient.nutritionRequest?.status === "pending"
      ? ingredient.nutritionRequest
      : null

  const commit = useCommit({ onSaveState, onSaved })
  // Every control here saves itself, so a failure has nowhere to live but a
  // toast.
  const save = (entry: Commit) =>
    commit(entry).then((failure) => {
      if (failure) toast.add({ title: failure.message, type: "error" })
    })

  const settings = `ingredient:${ingredient.id}:nutrition-settings`
  // The three settings share one domain, so every write carries all three:
  // a write that coalesces over another must not drop what it replaced.
  const writeSettings = (next: {
    labelName?: string
    nonEdible?: boolean
    sugarsAreAdded?: boolean
  }) =>
    updateIngredientNutritionSettings(ingredient.id, {
      labelName: savedLabelName,
      nonEdible,
      sugarsAreAdded,
      ...next,
    })
  const source = `ingredient:${ingredient.id}:nutrition-source`
  const allergens = `ingredient:${ingredient.id}:allergens`
  // A refused write puts its whole domain back, not only the field it touched.
  const settingsRevert = () => {
    const previous = { savedLabelName, nonEdible, sugarsAreAdded }
    return () => {
      setSavedLabelName(previous.savedLabelName)
      setNonEdible(previous.nonEdible)
      setSugarsAreAdded(previous.sugarsAreAdded)
    }
  }
  const allergensRevert = () => {
    const previous = { selection, hints }
    return () => {
      setSelection(previous.selection)
      setHints(previous.hints)
    }
  }

  const choose = (match: NutritionFoodMatch) => {
    const previous = nutrition
    return save({
      domain: source,
      apply: () =>
        setNutrition({ source: "usda_fdc", description: match.description }),
      revert: () => setNutrition(previous),
      write: () => setIngredientNutrition(ingredient.id, match.fdcId),
    })
  }

  const clear = () => {
    const previous = nutrition
    return save({
      domain: source,
      apply: () => setNutrition(null),
      revert: () => setNutrition(previous),
      write: () => clearIngredientNutrition(ingredient.id),
    })
  }

  const saveLabelName = () => {
    const next = labelName.trim()
    if (next === savedLabelName) return Promise.resolve()
    const revert = settingsRevert()
    return save({
      domain: settings,
      apply: () => {
        setLabelName(next)
        setSavedLabelName(next)
      },
      // The typed name stays on screen — the form reads Draft again.
      revert,
      write: () => writeSettings({ labelName: next }),
    })
  }

  // The header's Save and Cmd+S blur first, so the field has already committed
  // by the time this runs; it is here so a screen of commits still has a save.
  React.useEffect(() => {
    if (saveRef) saveRef.current = saveLabelName
  })
  const dirty = labelName.trim() !== savedLabelName
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const toggle = (key: AllergenKey, row: AllergenRow) => {
    const previous = selection
    const revert = allergensRevert()
    const next: Selection = {
      contains: new Set(previous.contains),
      mayContain: new Set(previous.mayContain),
    }
    const wasIn = next[row].has(key)
    next.contains.delete(key)
    next.mayContain.delete(key)
    if (!wasIn) next[row].add(key)
    void save({
      domain: allergens,
      apply: () => setSelection(next),
      revert,
      write: () =>
        replaceIngredientAllergens(
          ingredient.id,
          allergenOverrides(next, ingredient.effectiveAllergens)
        ),
    })
  }

  const confirmHint = (key: string, row: AllergenRow) => {
    const previousSelection = selection
    const previousHints = hints
    const revert = allergensRevert()
    const next: Selection = {
      contains: new Set(previousSelection.contains),
      mayContain: new Set(previousSelection.mayContain),
    }
    next[row].add(key)
    void save({
      domain: allergens,
      apply: () => {
        setSelection(next)
        setHints(withoutHint(previousHints, key))
      },
      revert,
      write: () =>
        replaceIngredientAllergens(
          ingredient.id,
          allergenOverrides(next, ingredient.effectiveAllergens)
        ),
    })
  }

  const dismissHint = (key: string) => {
    const previousHints = hints
    const revert = allergensRevert()
    void save({
      domain: allergens,
      apply: () => setHints(withoutHint(previousHints, key)),
      revert,
      write: () =>
        replaceIngredientAllergens(
          ingredient.id,
          allergenOverrides(
            selection,
            ingredient.effectiveAllergens,
            key as AllergenKey
          )
        ),
    })
  }

  // The package text belongs to the record on the server; a just-chosen food
  // has none until the screen refetches.
  const packageIngredients =
    nutrition && nutrition.description === ingredient.nutrition?.description
      ? ingredient.nutrition.packageIngredients
      : ""
  const hintCount =
    hints.contains.length + hints.mayContain.length + hints.checkLabel.length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-sm leading-none font-medium">Nutrition data</span>
        <UsdaFoodCombobox value={nutrition} onChoose={choose} onClear={clear} />
        {packageIngredients ? (
          <div className="flex flex-col gap-1">
            <FieldDescription className={packageOpen ? undefined : "truncate"}>
              Package label: {packageIngredients}
            </FieldDescription>
            {packageOpen ? null : (
              <button
                type="button"
                onClick={() => setPackageOpen(true)}
                className="w-fit text-xs text-muted-foreground underline decoration-1 underline-offset-4 outline-none hover:text-foreground focus-visible:text-foreground"
              >
                Show all
              </button>
            )}
          </div>
        ) : null}
        {requestPending ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Request pending
            </span>
            {sentRequest ? (
              sentOpen ? (
                <SentRequestValues request={sentRequest} />
              ) : (
                <button
                  type="button"
                  onClick={() => setSentOpen(true)}
                  className="w-fit text-xs text-muted-foreground underline decoration-1 underline-offset-4 outline-none hover:text-foreground focus-visible:text-foreground"
                >
                  Show what was sent
                </button>
              )
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRequestOpen(true)}
            className="w-fit text-xs text-muted-foreground underline decoration-1 underline-offset-4 outline-none hover:text-foreground focus-visible:text-foreground"
          >
            No match? Request a custom value
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ingredient-label-name">Name on label</Label>
        <Input
          id="ingredient-label-name"
          value={labelName}
          maxLength={120}
          placeholder={ingredient.name}
          onChange={(event) => setLabelName(event.target.value)}
          onBlur={saveLabelName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()
          }}
        />
        <FieldDescription>
          How this ingredient reads in the ingredients list. Leave blank to use
          its name.
        </FieldDescription>
      </div>

      <div className="flex flex-col gap-2.5">
        <label className="flex items-center gap-2.5 text-base">
          <Checkbox
            checked={nonEdible}
            onCheckedChange={(checked) => {
              const next = checked === true
              void save({
                domain: settings,
                apply: () => setNonEdible(next),
                revert: settingsRevert(),
                write: () => writeSettings({ nonEdible: next }),
              })
            }}
          />
          Not food (packaging, equipment)
        </label>
        <label className="flex items-center gap-2.5 text-base">
          <Checkbox
            checked={sugarsAreAdded}
            onCheckedChange={(checked) => {
              const next = checked === true
              void save({
                domain: settings,
                apply: () => setSugarsAreAdded(next),
                revert: settingsRevert(),
                write: () => writeSettings({ sugarsAreAdded: next }),
              })
            }}
          />
          Count its sugars as added sugars (sugar, honey, syrups)
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm leading-none font-medium">Allergens</span>
        <FieldDescription>
          Catalog defaults are already selected. Tap to change them.
        </FieldDescription>
        <div className="mt-1">
          <AllergenChips
            region={labelRegion}
            value={{
              contains: [...selection.contains],
              mayContain: [...selection.mayContain],
            }}
            onToggle={toggle}
          />
        </div>
        {hintCount > 0 ? (
          <div className="mt-3 flex flex-col gap-2.5">
            <AllergenHintRow
              label="From the package label"
              keys={hints.contains}
              onConfirm={(key) => confirmHint(key, "contains")}
              onDismiss={dismissHint}
            />
            <AllergenHintRow
              label="May contain, from the package label"
              keys={hints.mayContain}
              onConfirm={(key) => confirmHint(key, "mayContain")}
              onDismiss={dismissHint}
            />
            <AllergenHintRow
              label="Depends on the brand. Check the label for:"
              keys={hints.checkLabel}
              onConfirm={(key) => confirmHint(key, "contains")}
              onDismiss={dismissHint}
            />
            <FieldDescription>{HINT_HELP}</FieldDescription>
          </div>
        ) : null}
      </div>

      {requestShown ? (
        <RequestCustomNutritionDialog
          ingredientId={ingredient.id}
          ingredientName={ingredient.name}
          open={requestOpen}
          onOpenChange={(next) => {
            if (!next) setRequestOpen(false)
          }}
          onSent={() => {
            setRequestPending(true)
            onSaved?.()
          }}
        />
      ) : null}
    </div>
  )
}
