"use client"

import * as React from "react"

import { saveIngredient } from "@/app/(app)/ingredients/actions"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { LabeledInput, LabeledShell } from "@/components/ui/labeled-field"
import { SaveBanner } from "@/components/ui/save-banner"
import type { SaveStatusState } from "@/components/ui/save-status"
import type { PurchaseUnit } from "@/components/ingredients/purchase-unit-dialog"
import { IngredientCategoryCombobox } from "@/components/ingredients/ingredient-category-combobox"
import { IngredientTagsCard } from "@/components/ingredients/ingredient-tags-card"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { toSaveFailure } from "@/lib/save-failure"
import type { IngredientTagOptionRow } from "@/lib/backend/types"

/** What a successful save wrote, so a table can reflect it immediately. */
export type SavedIngredientPack = {
  /** The `ing_` id the detail route resolves by. */
  publicId: string
  name: string
  purchaseCostCents: number
  purchaseSize: number
  purchaseUnit: string
}

export type IngredientFormValues = {
  id: string
  name: string
  /** The category name, or null when the ingredient is unfiled. */
  category: string | null
  /** The counter the save sends back as its expectation. */
  editVersion: number
  purchaseCostCents: number
  purchaseSize: number | null
  purchaseUnit: string | null
  priceSource: "catalog" | "master" | "user"
  tags?: Array<{ id: string; name: string }>
}

type IngredientFormProps = {
  initial: IngredientFormValues | null
  initialName?: string
  onSaved?: (id: string, values: SavedIngredientPack) => void | Promise<void>
  onDone: () => void
  /** Cancel's own exit, so a dirty-close guard can intercept it. */
  onCancel?: () => void
  /** Lets a screen that owns the Save button submit this form from outside it. */
  saveRef: React.RefObject<(() => Promise<unknown>) | null>
  /** Fires whenever the form starts or stops differing from what was loaded. */
  onDirtyChange?: (dirty: boolean) => void
  /** Which fields to render; the detail screen splits them across its tabs. */
  section?: "all" | "ingredient"
  /** Creates a supply rather than an ingredient, in the one save. */
  nonEdible?: boolean
  /** Gives the ingredient screen its full profile section layout. */
  profileLayout?: boolean
  availableTags?: IngredientTagOptionRow[]
  /** Category names the pantry already uses, for the combobox. */
  categoryOptions?: readonly string[]
  /** Profile sections rendered between the name and tags. */
  children?: React.ReactNode
  /** False on screens that save from their own header. */
  actions?: boolean
  /** Lets a screen that owns the Save button mirror what the submit is doing. */
  onSaveStateChange?: (state: SaveStatusState) => void
  purchaseUnit?: PurchaseUnit | null
  /** The version a purchase-unit write echoed, adopted so the next save is
   *  not stale. */
  packVersion?: number | null
}

const NAME_FIELD = "ingredient-name"

/** The shared profile form used by both new and saved ingredient screens. */
export function IngredientForm({
  initial,
  initialName,
  onSaved,
  onDone,
  onCancel,
  saveRef,
  onDirtyChange,
  section = "all",
  nonEdible = false,
  profileLayout = false,
  availableTags = [],
  categoryOptions = [],
  children,
  actions = true,
  onSaveStateChange,
  purchaseUnit,
  packVersion = null,
}: IngredientFormProps) {
  const shows = (part: "ingredient") => section === "all" || section === part
  const [values, setValues] = React.useState({
    name: initial?.name ?? initialName ?? "",
    category: initial?.category ?? "",
    tags: (initial?.tags ?? []).map((tag) => tag.name).join(", "),
  })
  const { name, category, tags } = values
  const tagNames = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
  // The version the next save writes against: what was loaded, then whatever a
  // pack write echoed, then what this form's own save came back with.
  const loadedVersion = initial?.editVersion ?? null
  const [version, setVersion] = React.useState(loadedVersion)
  const [lastLoadedVersion, setLastLoadedVersion] =
    React.useState(loadedVersion)
  if (lastLoadedVersion !== loadedVersion) {
    setLastLoadedVersion(loadedVersion)
    setVersion(loadedVersion)
  }
  const [lastPackVersion, setLastPackVersion] = React.useState(packVersion)
  if (lastPackVersion !== packVersion) {
    setLastPackVersion(packVersion)
    if (packVersion !== null) setVersion(packVersion)
  }
  // The pack belongs to `ingredient:<id>:purchase-unit`, so a saved
  // ingredient's form never restates it; a create carries what was typed.
  const purchase = initial
    ? null
    : {
        purchaseCostCents: purchaseUnit
          ? Math.max(
              0,
              Math.round(Number.parseFloat(purchaseUnit.cost) * 100) || 0
            )
          : 0,
        purchaseSize: purchaseUnit
          ? Number.isFinite(Number.parseFloat(purchaseUnit.size))
            ? Number.parseFloat(purchaseUnit.size)
            : null
          : null,
        purchaseUnit: purchaseUnit?.unit ?? null,
      }

  const form = useFormSave({
    snapshot: JSON.stringify(values),
    saved: initial !== null,
    validate: (): FormErrors =>
      name.trim() ? {} : { [NAME_FIELD]: "Enter a name." },
    save: async () => {
      const result = await saveIngredient({
        id: initial?.id ?? null,
        name: name.trim(),
        category: category.trim() || null,
        tags: tagNames,
        ...(version === null ? {} : { expectedEditVersion: version }),
        ...(nonEdible ? { nonEdible: true } : {}),
        ...(purchase ?? {}),
      })
      if ("error" in result) return toSaveFailure(result)
      setVersion(result.editVersion)
      if (onSaved)
        await onSaved(result.id, {
          publicId: result.publicId,
          name: name.trim(),
          purchaseCostCents: purchase?.purchaseCostCents ?? 0,
          purchaseSize: purchase?.purchaseSize ?? 0,
          purchaseUnit: purchase?.purchaseUnit ?? "",
        })
      onDone()
      return null
    },
  })

  const { dirty, saveState, submit } = form
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  React.useEffect(
    () => onSaveStateChange?.(saveState),
    [onSaveStateChange, saveState]
  )

  // Re-registered every render, so the header's Save sends what the form
  // says now rather than what it said when it mounted.
  React.useEffect(() => {
    saveRef.current = submit
    return () => {
      saveRef.current = null
    }
  })

  const update = (patch: Partial<typeof values>) =>
    setValues((one) => ({ ...one, ...patch }))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {form.failure?.kind === "conflict" ? (
        <SaveBanner text={form.failure.message}>
          <Button
            type="button"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </SaveBanner>
      ) : null}
      {shows("ingredient") ? (
        profileLayout ? (
          <div className="min-w-0">
            <div className="grid max-w-[640px] gap-4 sm:grid-cols-2">
              <LabeledInput
                label="Name (required)"
                id={NAME_FIELD}
                autoFocus
                value={name}
                onChange={(event) => update({ name: event.target.value })}
              />
              <LabeledShell label="Category">
                <IngredientCategoryCombobox
                  value={category}
                  options={categoryOptions}
                  onChange={(next) => update({ category: next })}
                />
              </LabeledShell>
            </div>
            {form.errors[NAME_FIELD] ? (
              <FieldError className="mt-2">
                {form.errors[NAME_FIELD]}
              </FieldError>
            ) : null}
            {children ? <div className="mt-8">{children}</div> : null}
            <hr className="mt-8 h-1.5 w-full max-w-[640px] rounded-sm border-0 bg-secondary" />
            <div className="mt-6 max-w-[640px]">
              <IngredientTagsCard
                options={availableTags}
                value={tagNames}
                onChange={(next) => update({ tags: next.join(", ") })}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <LabeledInput
              label="Name (required)"
              id={NAME_FIELD}
              autoFocus
              value={name}
              onChange={(event) => update({ name: event.target.value })}
            />
            <LabeledInput
              label="Tags (comma separated)"
              id="ingredient-tags"
              value={tags}
              onChange={(event) => update({ tags: event.target.value })}
            />
            {form.errors[NAME_FIELD] ? (
              <FieldError>{form.errors[NAME_FIELD]}</FieldError>
            ) : null}
          </div>
        )
      ) : null}

      {!profileLayout ? children : null}

      {form.failure && form.failure.kind !== "conflict" ? (
        <FieldError className="mt-3">{form.failure.message}</FieldError>
      ) : null}

      {actions ? (
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel ?? onDone}>
            Cancel
          </Button>
          <Button type="submit" pending={form.pending}>
            {initial && initial.priceSource !== "user"
              ? "Use my price"
              : "Save ingredient"}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
