"use client"

import * as React from "react"
import { ChevronRight, CircleAlert } from "lucide-react"

import {
  setRecipeItemExcludedFromCost,
  updateRecipeCosting,
} from "@/app/(app)/recipes/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { GuardedLink } from "@/components/navigation-blocker"
import { BatchSizeSelect } from "@/components/recipes/batch-size-select"
import { CustomBatchDialog } from "@/components/recipes/custom-batch-dialog"
import { RecipeCostingPanel } from "@/components/recipes/recipe-panels"
import { WarningLine } from "@/components/recipes/warning-line"
import { Button } from "@/components/ui/button"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import { MeasureField } from "@/components/ui/measure-field"
import { useToast } from "@/components/ui/toast"
import { scaleBatchCost } from "@/lib/benchcost/math"
import { centsToDollarInput, dollarsToCents, formatCents } from "@/lib/money"
import { recipePortions } from "@/lib/recipe/portions"
import type { WeighEquivalency } from "@/lib/recipe/weigh"
import {
  priceParsedLines,
  type PriceListEntry,
  type PricedLine,
} from "@/lib/pricing"
import { parseRecipeText } from "@/lib/recipe"
import { useRecipeEdit } from "@/components/recipes/recipe-chrome"
import { useCommit } from "@/hooks/use-commit"
import type { YieldUnit } from "@/lib/units"
import { servingUnitOptions, unitShort, unitWord } from "@/lib/unit-registry"
import { cn } from "@/lib/utils"

const priceText = (cents: number | null) =>
  cents === null ? "" : centsToDollarInput(cents)

const PORTION_UNIT_OPTIONS = servingUnitOptions()
const rowClass =
  "flex items-center justify-between gap-4 border-b border-muted py-3 last:border-b-0"
const labelClass = "text-base text-muted-foreground"
const moneyLabelClass = "text-base font-medium text-foreground"
const readOnlyValueClass = "w-40 text-base font-medium tabular-nums"

const signedDollarsToCents = (input: string): number | null => {
  const cleaned = input.replace(/[$,\s]/g, "")
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? Math.round(value * 100) : null
}

/** The Cost tab: the batch table plus the per-portion figures beneath it. */
export function RecipeCostView({
  recipeId,
  recipePublicId,
  canEditCosting,
  lines,
  recipeYield,
  equivalency,
  servingAmount,
  servingUnit,
  menuPriceCents,
  steps,
  prepTimeSeconds,
  autoPrepTimeEnabled,
  priceList,
}: {
  recipeId: string
  recipePublicId: string
  /** Owners set the commercial portion and price here; everyone else reads. */
  canEditCosting: boolean
  /** The measured lines, as written; the batch in the header scales them. */
  lines: {
    /** The saved row this line is: what the left-out toggle writes to. */
    itemId: string
    kind: "ingredient" | "subrecipe"
    quantity: number | null
    unit: string
    displayName: string
    excludedFromCost: boolean
    /** The saved ingredient or recipe link; display text is not identity. */
    targetId: string | null
    /** This row's authoritative contribution to the original batch. */
    costCents: number | null
  }[]
  recipeYield: { amount: number; unit: YieldUnit } | null
  equivalency: WeighEquivalency | null
  servingAmount: number | null
  servingUnit: string
  menuPriceCents: number | null
  /** What the method costs: the labor kind and the time each step takes. */
  steps: {
    laborKind: "" | "active" | "passive"
    timings: { seconds: number }[]
  }[]
  prepTimeSeconds: number | null
  autoPrepTimeEnabled: boolean
  priceList: PriceListEntry[]
}) {
  const { foodCostTarget, wagePerHourCents } = useBusinessSettings()
  const { batch, setBatch, registerSave, setDirty, setSaveState } =
    useRecipeEdit()
  const [customOpen, setCustomOpen] = React.useState(false)
  const scale = batch.scale
  // What a toggle just asked for, until the refreshed read carries it.
  const [leftOutDraft, setLeftOutDraft] = React.useState<
    Record<string, boolean>
  >({})
  const leftOutOf = React.useCallback(
    (line: { itemId: string; excludedFromCost: boolean }) =>
      leftOutDraft[line.itemId] ?? line.excludedFromCost,
    [leftOutDraft]
  )
  const parsed = React.useMemo(() => {
    const result = parseRecipeText(
      lines
        .map((line) =>
          [
            line.quantity === null ? "" : line.quantity * scale,
            line.unit,
            line.displayName,
          ]
            .filter(Boolean)
            .join(" ")
        )
        .join("\n"),
      { identities: priceList }
    )
    // One parsed line per item, in written order, so the flag lands on its own.
    for (const [index, line] of result.parsedLines.entries()) {
      const saved = lines[index]
      line.excludedFromCost = saved ? leftOutOf(saved) : false
    }
    return result
  }, [leftOutOf, lines, priceList, scale])
  // The backend follows saved ingredient and sub-recipe ids recursively. The
  // cost tab must not re-match those rows by display name: doing so dropped
  // nested recipe costs and made duplicate titles ambiguous.
  const basePriced = React.useMemo<PricedLine[]>(
    () =>
      parsed.parsedLines.map((line, index) => {
        const saved = lines[index]
        const selected = priceList.find((entry) => entry.id === saved?.targetId)
        const selectedHasPrice = Boolean(
          selected?.purchaseUnit && (selected.purchaseSize ?? 0) > 0
        )
        const probe = selected
          ? priceParsedLines(
              [line],
              [selected],
              [{ line: line.ingredientName, targetId: selected.id }]
            ).lines[0]
          : null
        const costCents =
          saved?.costCents === null || saved?.costCents === undefined
            ? null
            : saved.costCents
        return {
          name: line.ingredientName,
          grams: line.ingredient?.grams ?? null,
          componentQuantity: line.componentQuantity,
          ingredientId: saved?.targetId ?? null,
          costCents,
          basis: costCents === null ? null : "sale-unit",
          needsConversion:
            costCents === null &&
            selectedHasPrice &&
            probe?.needsConversion === true,
          needsReview: false,
        }
      }),
    [lines, parsed, priceList]
  )
  const scaledYield = recipeYield && {
    ...recipeYield,
    amount: recipeYield.amount * scale,
  }
  const [portionAmount, setPortionAmount] = React.useState(
    servingAmount === null ? "" : String(servingAmount)
  )
  const [portionUnit, setPortionUnit] = React.useState(servingUnit)
  const portionNumber = Number(portionAmount)
  const portionIsBlank = !portionAmount.trim() && !portionUnit
  const portionPairIsInvalid =
    !portionAmount.trim() !== !portionUnit ||
    (Boolean(portionAmount.trim()) &&
      (!Number.isFinite(portionNumber) || portionNumber <= 0))
  const draftServingAmount = portionIsBlank
    ? null
    : portionPairIsInvalid
      ? null
      : portionNumber
  const basePortions = recipePortions(
    {
      id: recipeId,
      yieldAmount: recipeYield?.amount ?? null,
      yieldUnit: recipeYield?.unit ?? null,
      equivalency,
    },
    {
      amount: draftServingAmount,
      unit: portionPairIsInvalid ? "" : portionUnit,
    }
  )
  const batchCost = React.useMemo(
    () =>
      scaleBatchCost({
        lineCostCents: basePriced.map((line) => line.costCents),
        basePortions,
        prepTimeSeconds,
        autoPrepTime: autoPrepTimeEnabled,
        steps: steps.map((step, index) => ({
          id: String(index),
          kind: step.laborKind === "active" ? "active" : "passive",
          timings: step.timings.map((timing) => ({
            seconds: timing.seconds,
            yieldCount: 1,
          })),
        })),
        wagePerHourCents,
        scale,
      }),
    [
      autoPrepTimeEnabled,
      basePortions,
      basePriced,
      prepTimeSeconds,
      scale,
      steps,
      wagePerHourCents,
    ]
  )
  const priced = React.useMemo<PricedLine[]>(
    () =>
      basePriced.map((line, index) => ({
        ...line,
        costCents: batchCost.lineCostCents[index] ?? null,
      })),
    [basePriced, batchCost.lineCostCents]
  )
  const { ingredientTotalCents, portions, labor, portionCostCents } = batchCost
  const portionIssue =
    recipeYield === null
      ? "Set a total yield on the Recipe tab to calculate cost per unit and use this recipe as a sub-recipe."
      : portionPairIsInvalid
        ? "Enter a positive portion amount and choose its unit."
        : portions !== null
          ? null
          : draftServingAmount
            ? "This portion cannot be related to the total yield."
            : "Set a portion to calculate cost per portion."
  // 0.3 reads as "30", 0.325 as "32.5".
  const targetPercent = Number((foodCostTarget * 100).toFixed(1))
  const [price, setPrice] = React.useState(priceText(menuPriceCents))
  const [desired, setDesired] = React.useState({
    servingAmount,
    servingUnit,
    menuPriceCents,
  })
  const [activeDriver, setActiveDriver] = React.useState<
    "price" | "food-cost" | "profit" | null
  >(null)
  const [foodCostDraft, setFoodCostDraft] = React.useState("")
  const [profitDraft, setProfitDraft] = React.useState("")
  const priceBeforeDriver = React.useRef(price)
  const [suggestedPricePending, setSuggestedPricePending] =
    React.useState(false)
  const draftSellCents = dollarsToCents(price)
  const priceIsBlank = price.trim() === ""
  const priceIsInvalid =
    !priceIsBlank && (draftSellCents === null || draftSellCents <= 0)
  const sellCents = priceIsInvalid ? null : draftSellCents
  const derivedFoodCost =
    sellCents && portionCostCents !== null
      ? ((portionCostCents / sellCents) * 100).toFixed(1)
      : ""
  const derivedProfit =
    sellCents === null || portionCostCents === null
      ? ""
      : centsToDollarInput(Math.round(sellCents - portionCostCents))
  const foodCostNumber = Number(foodCostDraft)
  const foodCostIsInvalid =
    activeDriver === "food-cost" &&
    (foodCostDraft.trim() === "" ||
      !Number.isFinite(foodCostNumber) ||
      foodCostNumber <= 0)
  const profitCents = signedDollarsToCents(profitDraft)
  const profitIsInvalid =
    activeDriver === "profit" &&
    (profitDraft.trim() === "" ||
      profitCents === null ||
      portionCostCents === null ||
      Math.round(portionCostCents + profitCents) <= 0)
  const suggestedPriceCents =
    portionCostCents !== null && portionCostCents > 0
      ? Math.round(portionCostCents / foodCostTarget)
      : null
  const toast = useToast()
  const commit = useCommit({
    onSaveState: setSaveState,
  })
  const persistCosting = (next: {
    servingAmount: number | null
    servingUnit: string
    menuPriceCents: number | null
  }) => {
    if (
      next.servingAmount === desired.servingAmount &&
      next.servingUnit === desired.servingUnit &&
      next.menuPriceCents === desired.menuPriceCents
    ) {
      setPrice(priceText(next.menuPriceCents))
      setDirty(false)
      return Promise.resolve()
    }
    const previous = desired
    return commit({
      domain: `recipe:${recipeId}:costing`,
      apply: () => {
        setPrice(priceText(next.menuPriceCents))
        setDesired(next)
        setDirty(false)
      },
      revert: () => {
        setPortionAmount(
          previous.servingAmount === null ? "" : String(previous.servingAmount)
        )
        setPortionUnit(previous.servingUnit)
        setPrice(priceText(previous.menuPriceCents))
        setDesired(previous)
      },
      write: () =>
        updateRecipeCosting({
          recipeId,
          ...next,
        }),
    }).then((failure) => {
      if (failure) toast.add({ title: failure.message, type: "error" })
    })
  }
  const toggleLeftOut = (index: number, leftOut: boolean) => {
    const saved = lines[index]
    if (!saved) return
    const previous = leftOutOf(saved)
    void commit({
      domain: `recipe:${recipeId}:item:${saved.itemId}:left-out`,
      apply: () =>
        setLeftOutDraft((current) => ({ ...current, [saved.itemId]: leftOut })),
      revert: () =>
        setLeftOutDraft((current) => ({
          ...current,
          [saved.itemId]: previous,
        })),
      write: () =>
        setRecipeItemExcludedFromCost(recipeId, saved.itemId, leftOut),
    }).then((failure) => {
      if (failure) toast.add({ title: failure.message, type: "error" })
    })
  }
  const saveCosting = async (override?: {
    portionAmount?: string
    portionUnit?: string
    price?: string
  }) => {
    const nextAmountText = override?.portionAmount ?? portionAmount
    const nextUnit = override?.portionUnit ?? portionUnit
    const nextPrice = override?.price ?? price
    const nextAmount = Number(nextAmountText)
    const blankPortion = !nextAmountText.trim() && !nextUnit
    const validPortion =
      blankPortion ||
      (Boolean(nextAmountText.trim()) &&
        Boolean(nextUnit) &&
        Number.isFinite(nextAmount) &&
        nextAmount > 0)
    const nextCents = dollarsToCents(nextPrice)
    const validPrice =
      nextPrice.trim() === "" || (nextCents !== null && nextCents > 0)
    // Answers with what is holding the write, so a caller that was asked for
    // it — the header's Save — can say so rather than look dead.
    if (!validPortion)
      return "Enter a positive portion amount and choose its unit."
    if (!validPrice) return "Sell price must be greater than $0."
    if (foodCostIsInvalid) return "Food cost must be greater than 0%."
    if (profitIsInvalid)
      return "Profit must result in a sell price greater than $0."
    await persistCosting({
      servingAmount: blankPortion ? null : nextAmount,
      servingUnit: blankPortion ? "" : nextUnit,
      menuPriceCents: nextCents,
    })
    return null
  }
  const driveFoodCost = (next: string) => {
    setFoodCostDraft(next)
    setDirty(true)
    const percent = Number(next)
    if (
      portionCostCents === null ||
      portionCostCents <= 0 ||
      !Number.isFinite(percent) ||
      percent <= 0
    )
      return
    const cents = Math.round(portionCostCents / (percent / 100))
    if (cents > 0) setPrice(priceText(cents))
  }
  const driveProfit = (next: string) => {
    setProfitDraft(next)
    setDirty(true)
    const cents = signedDollarsToCents(next)
    if (portionCostCents === null || cents === null) return
    const nextPriceCents = Math.round(portionCostCents + cents)
    if (nextPriceCents > 0) setPrice(priceText(nextPriceCents))
  }
  const finishDriver = async (driver: "food-cost" | "profit") => {
    const text = driver === "food-cost" ? foodCostDraft : profitDraft
    const invalid = driver === "food-cost" ? foodCostIsInvalid : profitIsInvalid
    if (!text.trim()) {
      setPrice(priceBeforeDriver.current)
      setActiveDriver(null)
      const currentAmount = portionAmount.trim() ? Number(portionAmount) : null
      setDirty(
        currentAmount !== desired.servingAmount ||
          portionUnit !== desired.servingUnit
      )
      return
    }
    if (invalid) return
    setActiveDriver(null)
    await saveCosting()
  }
  const applySuggestedPrice = async () => {
    if (suggestedPriceCents === null) return
    setSuggestedPricePending(true)
    setPrice(priceText(suggestedPriceCents))
    await saveCosting({ price: priceText(suggestedPriceCents) })
    setSuggestedPricePending(false)
  }
  const priceIssue =
    portionIssue !== null
      ? null
      : priceIsInvalid
        ? "Sell price must be greater than $0."
        : foodCostIsInvalid
          ? "Food cost must be greater than 0%."
          : profitIsInvalid
            ? "Profit must result in a sell price greater than $0."
            : sellCents === null
              ? "Set a sell price to calculate food cost and profit."
              : portionCostCents !== null && sellCents < portionCostCents
                ? "Sell price is below portion cost."
                : null

  const saveFromHeader = async () => {
    const blocker = await saveCosting()
    if (blocker) toast.add({ title: blocker, type: "error" })
  }
  // The ref keeps registration stable while any costing field changes.
  const saveCostingRef = React.useRef(saveFromHeader)
  React.useEffect(() => {
    saveCostingRef.current = saveFromHeader
  })
  React.useEffect(() => {
    if (!canEditCosting) return
    registerSave(() => saveCostingRef.current())
    return () => {
      registerSave(null)
      setDirty(false)
    }
  }, [canEditCosting, registerSave, setDirty])

  return (
    <div className="w-full max-w-[1180px] pb-16">
      <div className="mb-4 flex items-center gap-3 text-sm">
        <span className="font-medium text-foreground">Batch size</span>
        <BatchSizeSelect
          value={batch}
          onChange={setBatch}
          onCustom={() => setCustomOpen(true)}
          className="w-44"
        />
      </div>
      <CustomBatchDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        recipeYield={recipeYield}
        onApply={(size) => setBatch(size)}
      />
      <RecipeCostingPanel
        lines={parsed.parsedLines}
        lineKinds={lines.map((line) => line.kind)}
        priced={priced}
        totalCents={ingredientTotalCents}
        yieldAmount={scaledYield?.amount ?? null}
        yieldWord={
          scaledYield
            ? scaledYield.unit === "pcs"
              ? "piece"
              : unitWord(scaledYield.unit) || null
            : null
        }
        labor={labor}
        priceList={priceList}
        fixUnitHref={
          canEditCosting
            ? `/recipes/${recipePublicId}/recipe#uom-equivalency`
            : undefined
        }
        canPrice={canEditCosting}
        onToggleLeftOut={canEditCosting ? toggleLeftOut : undefined}
      />
      {/* The same band the recipe page draws between sections. */}
      <div className="mt-8 mb-7 border-t-[6px] border-secondary" />
      <div className="max-w-[560px]">
        <h3 className="border-b border-muted pb-2 text-lg font-semibold text-foreground">
          Per portion
        </h3>

        <div className={rowClass}>
          <span className={labelClass}>Portion size</span>
          <span
            className={cn(
              "relative flex items-center",
              canEditCosting && portionPairIsInvalid && "pr-6 md:pr-0"
            )}
          >
            {canEditCosting ? (
              <MeasureField
                className="h-8 w-40"
                label="Portion size"
                invalid={portionPairIsInvalid}
                amount={portionAmount}
                unit={portionUnit || null}
                options={PORTION_UNIT_OPTIONS}
                onAmountChange={(next) => {
                  setPortionAmount(next)
                  setDirty(true)
                }}
                onAmountKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
                onUnitChange={(unit) => {
                  const next = unit ?? ""
                  setPortionUnit(next)
                  setDirty(true)
                  void saveCosting({ portionUnit: next })
                }}
                onBlur={() => void saveCosting()}
              />
            ) : (
              <span className={readOnlyValueClass}>
                {servingAmount
                  ? `${servingAmount} ${unitShort(servingUnit)}`
                  : "–"}
              </span>
            )}
            {/* The red field says where; the mark says what, without a
              sentence under a list this short. */}
            {canEditCosting && portionPairIsInvalid ? (
              <CircleAlert
                role="img"
                aria-label="Enter a positive portion amount and choose its unit."
                className="absolute top-1/2 right-0 size-4 -translate-y-1/2 text-destructive md:-right-6"
                strokeWidth={2}
              />
            ) : null}
          </span>
        </div>

        <div className={rowClass}>
          <span className={moneyLabelClass}>Cost / portion</span>
          <span className="w-40">
            <span className="block font-medium tabular-nums">
              {portionCostCents === null ? "–" : formatCents(portionCostCents)}
            </span>
            {portionCostCents !== null &&
            !Number.isInteger(portionCostCents) ? (
              <span className="block text-xs text-muted-foreground">
                uses unrounded cost
              </span>
            ) : null}
          </span>
        </div>

        <div className={rowClass}>
          <span className={moneyLabelClass}>Sell price</span>
          {canEditCosting ? (
            <InputGroup className="w-40">
              <InputAffix>$</InputAffix>
              <Input
                className="h-8 pl-[26px] tabular-nums"
                type="number"
                min="0"
                step="0.01"
                value={price}
                placeholder="0.00"
                aria-label="Sell price"
                aria-invalid={priceIsInvalid}
                onFocus={() => setActiveDriver("price")}
                onChange={(event) => {
                  setPrice(event.target.value)
                  setDirty(true)
                }}
                onBlur={() => {
                  setActiveDriver(null)
                  void saveCosting()
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
              />
            </InputGroup>
          ) : (
            <span className={readOnlyValueClass}>
              {sellCents === null ? "–" : formatCents(sellCents)}
            </span>
          )}
        </div>

        <div className={rowClass}>
          <span className={labelClass}>Food cost</span>
          {canEditCosting ? (
            <InputGroup className="w-40">
              <Input
                className="h-8 pr-8 tabular-nums"
                type="number"
                min="0.1"
                step="0.1"
                value={
                  activeDriver === "food-cost" ? foodCostDraft : derivedFoodCost
                }
                placeholder="–"
                aria-label="Food cost percentage"
                aria-invalid={foodCostIsInvalid}
                disabled={portionCostCents === null || portionCostCents <= 0}
                onFocus={() => {
                  priceBeforeDriver.current = price
                  setFoodCostDraft(derivedFoodCost)
                  setActiveDriver("food-cost")
                }}
                onChange={(event) => driveFoodCost(event.target.value)}
                onBlur={() => void finishDriver("food-cost")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
              />
              <InputAffix side="end">%</InputAffix>
            </InputGroup>
          ) : (
            <span className={readOnlyValueClass}>
              {derivedFoodCost ? `${derivedFoodCost}%` : "–"}
            </span>
          )}
        </div>

        <div className={rowClass}>
          <span className={moneyLabelClass}>Profit</span>
          {canEditCosting ? (
            <InputGroup className="w-40">
              <InputAffix>$</InputAffix>
              <Input
                className="h-8 pl-[26px] tabular-nums"
                type="number"
                step="0.01"
                value={activeDriver === "profit" ? profitDraft : derivedProfit}
                placeholder="–"
                aria-label="Profit dollars"
                aria-invalid={profitIsInvalid}
                disabled={portionCostCents === null || portionCostCents <= 0}
                onFocus={() => {
                  priceBeforeDriver.current = price
                  setProfitDraft(derivedProfit)
                  setActiveDriver("profit")
                }}
                onChange={(event) => driveProfit(event.target.value)}
                onBlur={() => void finishDriver("profit")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur()
                }}
              />
            </InputGroup>
          ) : (
            <span className={readOnlyValueClass}>
              {sellCents === null || portionCostCents === null
                ? "–"
                : formatCents(sellCents - portionCostCents)}
            </span>
          )}
        </div>

        <div className={rowClass}>
          <span className={labelClass}>
            Suggested at {targetPercent}% food cost
          </span>
          {suggestedPriceCents !== null && canEditCosting ? (
            <Button
              type="button"
              variant="link"
              className="h-auto w-40 justify-start p-0"
              pending={suggestedPricePending}
              onClick={() => void applySuggestedPrice()}
            >
              Use {formatCents(suggestedPriceCents)}
            </Button>
          ) : (
            <span className={readOnlyValueClass}>
              {suggestedPriceCents === null
                ? "–"
                : formatCents(suggestedPriceCents)}
            </span>
          )}
        </div>
      </div>
      {portionIssue && !portionPairIsInvalid ? (
        <div className="mt-3">
          <WarningLine>
            {portionIssue}{" "}
            {canEditCosting && draftServingAmount && recipeYield ? (
              <GuardedLink
                href={`/recipes/${recipePublicId}/recipe#uom-equivalency`}
                className="inline-flex items-center font-medium text-primary hover:underline hover:underline-offset-4"
              >
                Open UOM
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </GuardedLink>
            ) : null}
          </WarningLine>
        </div>
      ) : null}
      {priceIssue ? (
        <div className="mt-3">
          <WarningLine>{priceIssue}</WarningLine>
        </div>
      ) : null}
    </div>
  )
}
