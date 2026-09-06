"use client"

import { IngredientCombobox } from "@/components/ingredients/ingredient-combobox"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import type { IngredientOption } from "@/components/ingredients/types"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  isPackUnit,
  packUnitGroups,
  unitDefinition,
  type PackUnitSlug,
} from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

/** Native selects, wearing the input's chrome: 32px, radius 8, one hairline. */
export const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground outline-none not-focus:hover:border-line-strong focus-visible:border-foreground"

const PACK_UNIT_GROUPS = packUnitGroups()

/** What one invoice line buys, priced for costing. */
export type LineCostValue = {
  /** "" creates a new ingredient under `name`. */
  ingredientId: string
  name: string
  /** Pack size, as typed. */
  amount: string
  /** A slug from the purchase vocabulary — a weight, a volume or a count. */
  unit: PackUnitSlug
  /** Pack price in dollars, as typed. */
  price: string
}

/**
 * The ingredient pricing an invoice line carries: which pantry item it updates
 * (or the name to create), what is in the pack, and what the pack cost.
 * Shared by the import dialog's resolve drawer and the invoice editor.
 */
export function LineCostFields({
  idPrefix,
  value,
  onChange,
  ingredients,
  currencyCode,
  /** What the "create" option offers when no name has been typed yet. */
  fallbackName,
  onIngredientCreated,
  className,
}: {
  idPrefix: string
  value: LineCostValue
  onChange: (patch: Partial<LineCostValue>) => void
  ingredients: IngredientOption[]
  currencyCode: string
  fallbackName: string
  /** A catalog row was adopted into the pantry; the screen's list should
   * learn it so the other lines can pick it too. */
  onIngredientCreated?: (ingredient: IngredientOption) => void
  className?: string
}) {
  // A pack counted in pieces says nothing about weight, and a recipe that
  // weighs the ingredient needs one. The dialog does not read the
  // ingredient's conversions, so the note is shown for every count pack.
  const countPack = unitDefinition(value.unit)?.family === "count"
  return (
    <div className={cn("grid gap-3 sm:grid-cols-3", className)}>
      <IngredientCombobox
        id={`${idPrefix}-ingredient`}
        value={value.ingredientId}
        onChange={(next) => onChange({ ingredientId: next })}
        ingredients={ingredients}
        createLabel={`Create “${value.name || fallbackName}”`}
        onCreated={(ingredient) => {
          onChange({ ingredientId: ingredient.id, name: ingredient.name })
          onIngredientCreated?.(ingredient)
        }}
        className="sm:col-span-3"
      />
      <LabeledInput
        label="Name"
        id={`${idPrefix}-name`}
        value={value.name}
        onChange={(event) => onChange({ name: event.target.value })}
      />
      <div className="flex gap-2">
        <LabeledInput
          label="Pack size"
          id={`${idPrefix}-amount`}
          type="number"
          min="0"
          step="any"
          value={value.amount}
          onChange={(event) => onChange({ amount: event.target.value })}
          containerClassName="min-w-0 flex-1"
          className="tabular"
        />
        <LabeledShell label="Unit" className="flex-none">
          <Select
            value={value.unit}
            onValueChange={(next) => {
              if (isPackUnit(next)) onChange({ unit: next })
            }}
          >
            <SelectTrigger
              aria-label="Pack size unit"
              className={cn(labeledControlClassName, "justify-between")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="w-33">
              {PACK_UNIT_GROUPS.map((group) => (
                <SelectGroup key={group.heading}>
                  <SelectLabel>{group.heading}</SelectLabel>
                  {group.units.map((unit) => (
                    <SelectItem key={unit.slug} value={unit.slug}>
                      {unit.slug}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </LabeledShell>
      </div>
      <LabeledInput
        label={`Pack price (${currencyCode})`}
        id={`${idPrefix}-price`}
        inputMode="decimal"
        value={value.price}
        onChange={(event) => onChange({ price: event.target.value })}
        className="tabular"
      />
      {countPack ? (
        <p className="text-xs leading-[1.55] text-muted-foreground sm:col-span-3">
          Recipes measured by weight will need the weight of one; set it on the
          ingredient’s Conversions.
        </p>
      ) : null}
    </div>
  )
}
