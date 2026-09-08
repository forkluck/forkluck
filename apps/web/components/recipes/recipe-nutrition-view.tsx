"use client"

import * as React from "react"
import {
  Book,
  Info,
  OctagonAlert,
  Package,
  Tag,
  TriangleAlert,
} from "lucide-react"

import {
  setRecipeItemYieldAfterCooking,
  setRecipeNutritionServing,
} from "@/app/(app)/recipes/actions"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { GuardedLink } from "@/components/navigation-blocker"
import { AllergenChips } from "@/components/nutrition/allergen-chips"
import { IngredientNutritionDialog } from "@/components/nutrition/ingredient-nutrition-dialog"
import { NutritionLabelCard } from "@/components/nutrition/nutrition-label"
import { nutritionSourceLabel } from "@/components/nutrition/usda-food-combobox"
import { useRecipeEdit } from "@/components/recipes/recipe-chrome"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import { MeasureField } from "@/components/ui/measure-field"
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useCommit, type Commit } from "@/hooks/use-commit"
import { formatAmount } from "@/lib/nutrition/label"
import type { RecipeNutrition, RecipeNutritionLine } from "@/lib/backend/types"
import { servingUnitOptions } from "@/lib/unit-registry"
import { formatWeight } from "@/lib/units"
import { cn } from "@/lib/utils"
import { useDialogTarget } from "@/components/ui/dialog"

const SERVING_UNITS = servingUnitOptions()

/** What each issue code asks the cook to do. */
const READINESS_COPY: Record<string, string> = {
  unlinkedIngredient:
    "Link nutrition data to every ingredient, or mark it not food.",
  unweighedItem:
    "Every line needs an amount Forkluck can weigh. Set the UOM on the ingredient for lines measured by volume or count.",
  unresolvedItem: "Give every line a quantity, a unit and a linked ingredient.",
  subrecipeIncomplete: "Finish the preview on every sub-recipe first.",
  subrecipeUnresolved:
    "A sub-recipe line uses a unit its recipe cannot relate to its yield. Set the UOM on that recipe.",
  subrecipeEmpty: "A sub-recipe has no ingredient lines yet.",
  allExcluded: "At least one line has to stay in the dish.",
  noYield: "Give the recipe a total yield on the Recipe tab.",
  noServingSize: "Set a serving size above.",
  servingNeedsEquivalency:
    "The yield and the serving use different units. Set the UOM on the Recipe tab so one can be read as the other.",
  packageNeedsEquivalency:
    "The yield and the package use different units. Set the UOM on the Recipe tab so one can be read as the other.",
  packageBelowServing: "A package can't be smaller than a serving.",
  servingAboveBatch: "A serving can't be more than the batch makes.",
  packageAboveBatch: "A package can't hold more than the batch makes.",
}

/** Which field each issue reddens. `noServingSize` keeps its amber tooltip. */
const SERVING_FIELD_ISSUES: string[] = [
  "servingNeedsEquivalency",
  "servingAboveBatch",
]
const PACKAGE_FIELD_ISSUES: string[] = [
  "packageNeedsEquivalency",
  "packageBelowServing",
  "packageAboveBatch",
]

/** The hint flag: never a blocker, only an invitation to open the line. */
const HINT_FLAG_COPY = "Allergen suggestions to confirm. Open the line."

const READINESS_FALLBACK =
  "Something on this recipe still stops the preview from building."

/** A reader cannot set the serving, so the sentence says who can. */
const VIEWER_SERVING_COPY = "The recipe owner has not set a serving size yet."

function readinessSentences(
  codes: readonly string[],
  owner: boolean
): string[] {
  return [
    ...new Set(
      codes.map((code) =>
        !owner && code === "noServingSize"
          ? VIEWER_SERVING_COPY
          : (READINESS_COPY[code] ?? READINESS_FALLBACK)
      )
    ),
  ]
}

const FLAG_COPY: Partial<Record<RecipeNutritionLine["status"], string>> = {
  unlinked: "No nutrition data yet",
  unweighed: "Could not turn this amount into grams",
  unresolved: "Needs a quantity, a unit and a linked ingredient",
  subrecipeIncomplete: "This recipe's own preview is not ready",
}

/** The yield after cooking cell: an integer share, 0..100, saved on blur. */
function YieldCell({
  value,
  onCommit,
}: {
  value: number
  onCommit: (percent: number) => Promise<void>
}) {
  const [text, setText] = React.useState(String(value))
  const commit = async () => {
    const percent = Number.parseInt(text, 10)
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      setText(String(value))
      return
    }
    if (percent === value) {
      setText(String(percent))
      return
    }
    await onCommit(percent)
  }
  return (
    <InputGroup className="w-16">
      <Input
        type="number"
        min="0"
        max="100"
        step="1"
        inputMode="numeric"
        aria-label="Yield after cooking"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setText(String(value))
            event.currentTarget.blur()
          }
        }}
        className="h-7 w-16 pr-5 pl-2 text-sm tabular-nums md:text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <InputAffix side="end" className="right-2 text-xs">
        %
      </InputAffix>
    </InputGroup>
  )
}

/** The Nutrition tab: the serving, the per-line table and the label preview. */
export function RecipeNutritionView({
  recipeId,
  owner,
  canEdit,
  recipeTitle,
  nutrition,
}: {
  recipeId: string
  /** Owners set the serving, link nutrition data and open the line dialog. */
  owner: boolean
  /** Editors and owners set yield after cooking. */
  canEdit: boolean
  recipeTitle: string
  nutrition: RecipeNutrition
}) {
  const toast = useToast()
  const { measurementSystem, labelRegion } = useBusinessSettings()
  const { registerSave, setDirty, setSaveState } = useRecipeEdit()
  const [amount, setAmount] = React.useState(
    nutrition.serving.amount === null ? "" : String(nutrition.serving.amount)
  )
  const [unit, setUnit] = React.useState<string | null>(
    nutrition.serving.unit || null
  )
  const [desiredServing, setDesiredServing] = React.useState({
    amount: nutrition.serving.amount,
    unit: nutrition.serving.unit,
  })
  const [packageAmount, setPackageAmount] = React.useState(
    nutrition.package.amount === null ? "" : String(nutrition.package.amount)
  )
  const [packageUnit, setPackageUnit] = React.useState<string | null>(
    nutrition.package.unit || null
  )
  const [desiredPackage, setDesiredPackage] = React.useState({
    amount: nutrition.package.amount,
    unit: nutrition.package.unit,
  })
  const [dialogFor, setDialogFor] = React.useState<string | null>(null)
  const heldDialogFor = useDialogTarget(dialogFor)
  // The yield a line's own commit put on screen, over what the server sent.
  const [yields, setYields] = React.useState<Record<string, number>>({})
  const commit = useCommit({
    onSaveState: setSaveState,
  })
  // Every control here saves itself, so a failure has nowhere to live but a
  // toast.
  const save = (entry: Commit) =>
    commit(entry).then((failure) => {
      if (failure) toast.add({ title: failure.message, type: "error" })
    })

  const packageHasChanges = () => {
    const value =
      packageAmount.trim() === "" ? null : Number.parseFloat(packageAmount)
    const unitValue = value === null ? "" : (packageUnit ?? "")
    return value !== desiredPackage.amount || unitValue !== desiredPackage.unit
  }

  const servingHasChanges = () => {
    const value = Number.parseFloat(amount)
    return (
      value !== desiredServing.amount || (unit ?? "") !== desiredServing.unit
    )
  }

  // Answers with what is holding the write, so the header's Save can say so
  // rather than look dead.
  const saveServing = (
    nextAmount: string,
    nextUnit: string | null
  ): Promise<string | null> => {
    const value = Number.parseFloat(nextAmount)
    if (!nextUnit || !Number.isFinite(value) || value <= 0)
      return Promise.resolve(
        "Enter a positive serving amount and choose its unit."
      )
    const previous = desiredServing
    if (value === previous.amount && nextUnit === previous.unit) {
      setDirty(packageHasChanges())
      return Promise.resolve(null)
    }
    return save({
      domain: `recipe:${recipeId}:serving`,
      apply: () => {
        setDesiredServing({ amount: value, unit: nextUnit })
        setDirty(packageHasChanges())
      },
      revert: () => {
        setAmount(previous.amount === null ? "" : String(previous.amount))
        setUnit(previous.unit || null)
        setDesiredServing(previous)
        setDirty(packageHasChanges())
      },
      write: () =>
        setRecipeNutritionServing(recipeId, { amount: value, unit: nextUnit }),
    }).then(() => null)
  }

  // Empty is a real answer here: it means one batch is one container.
  const savePackage = (
    nextAmount: string,
    nextUnit: string | null,
    servingStillDirty = servingHasChanges()
  ): Promise<string | null> => {
    const typed = Number.parseFloat(nextAmount)
    const cleared = nextAmount.trim() === ""
    if (!cleared && (!nextUnit || !Number.isFinite(typed) || typed <= 0))
      return Promise.resolve(
        "Enter a positive package amount and choose its unit, or clear both."
      )
    const value = cleared ? null : typed
    const unitValue = cleared ? "" : (nextUnit ?? "")
    const previous = desiredPackage
    if (value === previous.amount && unitValue === previous.unit) {
      setDirty(servingStillDirty)
      return Promise.resolve(null)
    }
    return save({
      domain: `recipe:${recipeId}:package`,
      apply: () => {
        if (cleared) setPackageUnit(null)
        setDesiredPackage({ amount: value, unit: unitValue })
        setDirty(servingStillDirty)
      },
      revert: () => {
        setPackageAmount(
          previous.amount === null ? "" : String(previous.amount)
        )
        setPackageUnit(previous.unit || null)
        setDesiredPackage(previous)
        setDirty(servingStillDirty)
      },
      write: () =>
        setRecipeNutritionServing(recipeId, {
          packageAmount: value,
          packageUnit: unitValue,
        }),
    }).then(() => null)
  }

  // The serving and package are this tab's form, so the header's Save button
  // saves them. The ref keeps the registration stable while they change.
  const saveFromHeader = async () => {
    const servingBlocker = await saveServing(amount, unit)
    const blocker =
      servingBlocker ?? (await savePackage(packageAmount, packageUnit, false))
    if (blocker) toast.add({ title: blocker, type: "error" })
  }
  const saveServingRef = React.useRef(saveFromHeader)
  React.useEffect(() => {
    saveServingRef.current = saveFromHeader
  })
  React.useEffect(() => {
    if (!owner) return
    registerSave(() => saveServingRef.current())
    return () => {
      registerSave(null)
      setDirty(false)
    }
  }, [owner, registerSave, setDirty])

  const saveYield = (itemId: string, percent: number, previous: number) =>
    save({
      domain: `recipe:${recipeId}:item:${itemId}:yield`,
      apply: () => setYields((current) => ({ ...current, [itemId]: percent })),
      revert: () =>
        setYields((current) => ({ ...current, [itemId]: previous })),
      write: () => setRecipeItemYieldAfterCooking(recipeId, itemId, percent),
    })

  const percentFor = (line: RecipeNutritionLine) =>
    yields[line.itemId] ?? line.efficiencyAfterCooking

  // The name column stays put while the rest scrolls; its hairline only
  // shows once there is something hidden behind it.
  const [scrolled, setScrolled] = React.useState(false)
  const stickyClass = cn(
    "sticky left-0 z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']",
    scrolled ? "after:bg-border" : "after:bg-transparent"
  )

  const servingMissing = nutrition.serving.amount === null
  const blockers = readinessSentences(nutrition.issues.batch, owner)
  const servingIssues = nutrition.issues.serving
  const servingBlockers = readinessSentences(servingIssues, owner)
  const servingFieldIssue = servingIssues.find((code) =>
    SERVING_FIELD_ISSUES.includes(code)
  )
  const packageFieldIssue = servingIssues.find((code) =>
    PACKAGE_FIELD_ISSUES.includes(code)
  )
  // Soft checks: units that look wrong but block nothing.
  const perContainer = nutrition.batch.servings
  const servingGrams = nutrition.serving.grams
  const servingWarning =
    perContainer !== null && perContainer > 50
      ? `Check the units: that is ${formatAmount(perContainer)} servings per container.`
      : servingGrams !== null && servingGrams < 1
        ? "Check the units: a serving under 1 g."
        : null
  const servingHint = servingMissing
    ? "Set a serving size to build the preview."
    : servingWarning
  const lines = nutrition.lines

  const packageNote =
    nutrition.batch.containers === null
      ? "Leave empty when one batch is one container."
      : `Fills ${formatAmount(nutrition.batch.containers)} containers.`
  return (
    <div className="w-full max-w-[1180px] pb-16">
      {/* The printed page is the preview alone, so it names the recipe. */}
      <h2 className="mb-4 hidden text-xl font-semibold print:block">
        {recipeTitle}
      </h2>
      <div className="flex flex-col gap-2 print:hidden">
        <p className="text-base leading-[1.55] text-muted-foreground">
          This estimate is worked out from the nutrition data linked to each
          ingredient and the weight that survives cooking.
        </p>
        <p className="text-base leading-[1.55] text-muted-foreground">
          It is a preview, not a verified label. Accuracy on a package is the
          seller’s responsibility, so have the numbers verified before you print
          one.
        </p>
        {owner ? null : (
          <p className="text-base leading-[1.55] text-muted-foreground">
            Shared with you to read. The recipe owner links nutrition data.
          </p>
        )}
      </div>

      {owner ? (
        <div className="mt-5 grid max-w-[720px] gap-4 text-sm sm:grid-cols-2 print:hidden">
          <div className="flex flex-col gap-2">
            <span className="flex h-5 items-center gap-2 text-sm leading-none font-medium text-foreground">
              Serving size
              {servingHint ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={servingHint}
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
                  <TooltipContent>{servingHint}</TooltipContent>
                </Tooltip>
              ) : null}
            </span>
            {/* The mark hangs outside the field, so a red field never moves. */}
            <div
              className={cn(
                "relative flex items-center",
                servingFieldIssue && "pr-6 md:pr-0"
              )}
            >
              <MeasureField
                label="Serving size"
                className="w-full"
                invalid={servingFieldIssue !== undefined}
                amount={amount}
                unit={unit}
                options={SERVING_UNITS}
                onAmountChange={(next) => {
                  setAmount(next)
                  setDirty(true)
                }}
                onUnitChange={(next) => {
                  setUnit(next)
                  void saveServing(amount, next)
                }}
                onBlur={() => void saveServing(amount, unit)}
              />
              {servingFieldIssue ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={READINESS_COPY[servingFieldIssue]}
                        className="absolute top-1/2 right-0 -translate-y-1/2 text-destructive md:-right-6"
                      />
                    }
                  >
                    <OctagonAlert
                      className="size-4"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {READINESS_COPY[servingFieldIssue]}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="flex h-5 items-center gap-2 text-sm leading-none font-medium text-foreground">
              Package size
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={packageNote}
                      className="flex size-5 items-center justify-center rounded-md text-muted-foreground"
                    />
                  }
                >
                  <Info
                    className="size-[13px]"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipContent>{packageNote}</TooltipContent>
              </Tooltip>
            </span>
            <div
              className={cn(
                "relative flex items-center",
                packageFieldIssue && "pr-6 md:pr-0"
              )}
            >
              <MeasureField
                label="Package size"
                className="w-full"
                invalid={packageFieldIssue !== undefined}
                amount={packageAmount}
                unit={packageUnit}
                options={SERVING_UNITS}
                onAmountChange={(next) => {
                  setPackageAmount(next)
                  setDirty(true)
                }}
                onUnitChange={(next) => {
                  setPackageUnit(next)
                  if (packageAmount.trim())
                    void savePackage(packageAmount, next)
                  else setDirty(true)
                }}
                onBlur={() => void savePackage(packageAmount, packageUnit)}
              />
              {packageFieldIssue ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={READINESS_COPY[packageFieldIssue]}
                        className="absolute top-1/2 right-0 -translate-y-1/2 text-destructive md:-right-6"
                      />
                    }
                  >
                    <OctagonAlert
                      className="size-4"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {READINESS_COPY[packageFieldIssue]}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {lines.length === 0 ? (
        <p className="mt-6 text-base text-muted-foreground print:hidden">
          Add ingredients on the Recipe tab and the preview builds from them
          here.
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <div className="flex min-w-0 flex-col gap-5 print:hidden">
            <TableFrame
              className="overflow-x-auto"
              onScroll={(event) =>
                setScrolled(event.currentTarget.scrollLeft > 0)
              }
            >
              <Table>
                <TableHeader>
                  <TableHeaderRow className="h-11">
                    <TableHead
                      className={cn(
                        "w-full max-w-0 min-w-[180px]",
                        stickyClass
                      )}
                    >
                      Ingredient
                    </TableHead>
                    <TableHead className="w-14 pl-0">
                      <span className="sr-only">Flags</span>
                    </TableHead>
                    <TableHead className="w-[240px] min-w-[180px]">
                      Nutrition source
                    </TableHead>
                    <TableHead className="w-[120px] whitespace-nowrap">
                      Yield after cooking
                    </TableHead>
                    <TableHead className="w-[110px] text-right">
                      Net weight
                    </TableHead>
                  </TableHeaderRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const flag = FLAG_COPY[line.status]
                    const subrecipeHref =
                      line.kind === "subrecipe" && line.subrecipePublicId
                        ? `/recipes/${line.subrecipePublicId}/nutrition`
                        : null
                    return (
                      <TableRow key={line.itemId} className="h-11">
                        <TableCell
                          className={cn(
                            "max-w-0",
                            stickyClass,
                            "group-hover/row:bg-fill-soft"
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                              {line.kind === "subrecipe" ? (
                                <Book
                                  className="size-3.5"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                              ) : (
                                <Package
                                  className="size-3.5"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                              )}
                            </span>
                            {subrecipeHref ? (
                              <GuardedLink
                                href={subrecipeHref}
                                className="truncate text-md font-medium underline decoration-1 underline-offset-4 outline-none hover:opacity-75 focus-visible:opacity-75"
                              >
                                {line.name}
                              </GuardedLink>
                            ) : (
                              <span className="truncate text-md">
                                {line.name}
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="w-14 pl-0">
                          <span className="flex items-center gap-1">
                            {flag ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      role="img"
                                      aria-label={flag}
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
                                <TooltipContent>{flag}</TooltipContent>
                              </Tooltip>
                            ) : null}
                            {line.hasAllergenHints &&
                            line.ingredientPublicId ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label={HINT_FLAG_COPY}
                                      onClick={() =>
                                        setDialogFor(line.ingredientPublicId)
                                      }
                                      className="flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                                    />
                                  }
                                >
                                  <Tag
                                    className="size-[13px]"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>
                                  {HINT_FLAG_COPY}
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-0 min-w-[180px] text-base">
                          <SourceCell
                            line={line}
                            owner={owner}
                            subrecipeHref={subrecipeHref}
                            onAdd={() => setDialogFor(line.ingredientPublicId)}
                          />
                        </TableCell>
                        <TableCell className="text-base tabular-nums">
                          {canEdit ? (
                            <YieldCell
                              key={`${line.itemId}:${percentFor(line)}`}
                              value={percentFor(line)}
                              onCommit={(percent) =>
                                saveYield(
                                  line.itemId,
                                  percent,
                                  percentFor(line)
                                )
                              }
                            />
                          ) : (
                            `${percentFor(line)}%`
                          )}
                        </TableCell>
                        <TableCell className="text-right text-base whitespace-nowrap tabular-nums">
                          {line.netGrams === null
                            ? "–"
                            : formatWeight(line.netGrams, measurementSystem)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableFrame>

            <section className="flex flex-col gap-2.5">
              <h2 className="text-md font-semibold">Allergens</h2>
              <AllergenChips
                value={nutrition.allergens}
                region={labelRegion}
                readOnly
              />
            </section>
          </div>

          {/* The label reads below the table, full width for the rows above. */}
          <hr className="h-1.5 w-full rounded-sm border-0 bg-secondary print:hidden" />
          <NutritionLabelCard
            className="w-full max-w-[520px] print:max-w-none"
            serving={nutrition.serving}
            servings={nutrition.batch.servings}
            perServing={nutrition.totals.perServing}
            per100g={nutrition.totals.per100g}
            statement={nutrition.statement}
            allergens={nutrition.allergens}
            readiness={nutrition.readiness}
            blockers={blockers}
            servingBlockers={servingBlockers}
          />
        </div>
      )}

      {heldDialogFor ? (
        <IngredientNutritionDialog
          key={heldDialogFor}
          publicId={heldDialogFor}
          open={dialogFor !== null}
          onOpenChange={(next) => {
            if (!next) setDialogFor(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** Where a line's nutrition comes from, or what it needs instead. */
function SourceCell({
  line,
  owner,
  subrecipeHref,
  onAdd,
}: {
  line: RecipeNutritionLine
  owner: boolean
  subrecipeHref: string | null
  onAdd: () => void
}) {
  if (line.kind === "subrecipe") {
    if (line.status !== "subrecipeIncomplete")
      return <span className="text-muted-foreground">From its own recipe</span>
    return subrecipeHref ? (
      <GuardedLink
        href={subrecipeHref}
        className="text-primary underline-offset-4 hover:underline"
      >
        Incomplete, open recipe
      </GuardedLink>
    ) : (
      <span className="text-muted-foreground">Incomplete, open recipe</span>
    )
  }
  if (line.status === "nonEdible")
    return <span className="text-muted-foreground">Not food</span>
  if (line.status === "discarded")
    return <span className="text-muted-foreground">Discarded</span>
  if (!owner) {
    const linked = line.status === "linked" || line.status === "unweighed"
    return (
      <span className="text-muted-foreground">
        {linked ? "Linked" : "Not linked"}
      </span>
    )
  }
  if (line.linkedDescription) {
    if (!owner) {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-sm bg-secondary px-[7px] py-0.5 text-2xs font-medium text-secondary-foreground">
            {nutritionSourceLabel(line.linkedSource ?? "usda_fdc")}
          </span>
          <span className="truncate">{line.linkedDescription}</span>
        </span>
      )
    }
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-sm bg-secondary px-[7px] py-0.5 text-2xs font-medium text-secondary-foreground">
          {nutritionSourceLabel(line.linkedSource ?? "usda_fdc")}
        </span>
        {/* The description is the edit affordance; tables carry no icons. */}
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Update nutrition for ${line.name}`}
          className="truncate text-left underline decoration-1 underline-offset-4 outline-none hover:opacity-75 focus-visible:opacity-75"
        >
          {line.linkedDescription}
        </button>
      </span>
    )
  }
  if (!line.ingredientPublicId)
    return <span className="text-muted-foreground">Not linked</span>
  return (
    <button
      type="button"
      onClick={onAdd}
      className="whitespace-nowrap text-primary underline-offset-4 hover:underline"
    >
      Add nutrition
    </button>
  )
}
