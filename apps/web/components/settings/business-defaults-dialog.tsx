"use client"

import * as React from "react"

import {
  getCurrencyConversionQuote,
  updateBusinessSettings,
  type CurrencyConversionQuote,
} from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field"
import {
  LabeledInput,
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PayrollBurdenEstimator } from "@/components/settings/payroll-burden-estimator"
import { Switch } from "@/components/ui/switch"
import { useDirtyDialog } from "@/hooks/use-dirty-dialog"
import { useFormSave, type FormErrors } from "@/hooks/use-form-save"
import { dialogSaveShortcut } from "@/hooks/use-save-shortcut"
import { centsToDollarInput, dollarsToCents, formatCents } from "@/lib/money"
import { toSaveFailure } from "@/lib/save-failure"
import {
  CURRENCY_OPTIONS,
  LABEL_REGION_LABELS,
  LABEL_REGIONS,
  TIMEZONE_OPTIONS,
  resolveFoodCostTarget,
  resolveOvertimeWeeklyMinutes,
  resolvePayrollTaxPercent,
  resolveUnpaidBreakMinutes,
  resolveUnpaidBreakPerHours,
  type BusinessSettings,
  type CurrencyCode,
  type LabelRegion,
  type MeasurementSystem,
} from "@/lib/business-settings"

const MEASUREMENT_SYSTEM_LABELS: Record<MeasurementSystem, string> = {
  metric: "Metric (g, kg)",
  us: "US customary (oz, lb)",
}

/** "New York (GMT-4)" — the city, then the offset in force today. */
function timezoneLabel(zone: string): string {
  const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date())
  const offset = parts.find((part) => part.type === "timeZoneName")?.value
  return offset ? `${city} (${offset})` : city
}

const WAGE_FIELD = "business-wage"
const FOOD_COST_FIELD = "food-cost-target"
const OVERTIME_FIELD = "overtime-weekly"
const PAYROLL_TAX_FIELD = "payroll-tax"
const BREAK_MINUTES_FIELD = "unpaid-break-minutes"
const BREAK_HOURS_FIELD = "unpaid-break-per-hours"

const CURRENCY_LABELS = Object.fromEntries(
  CURRENCY_OPTIONS.map((currency) => [
    currency.code,
    `${currency.code} — ${currency.label}`,
  ])
) as Record<CurrencyCode, string>

/** The `$` an input wears as a prefix, in the workspace's own currency. */
function currencySymbol(code: CurrencyCode): string {
  const parts = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0)
  return parts.find((part) => part.type === "currency")?.value ?? code
}

/**
 * The 470px standard modal: two picker popovers over a pair of number fields.
 * Currency is the one value that can't just be saved — changing it converts
 * every stored cost once, so the click routes through a rate confirmation.
 */
export function BusinessDefaultsDialog({
  initialSettings,
  open,
  onOpenChange,
}: {
  initialSettings: BusinessSettings
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [measurementSystem, setMeasurementSystem] =
    React.useState<MeasurementSystem>(initialSettings.measurementSystem)
  const [currencyCode, setCurrencyCode] = React.useState<CurrencyCode>(
    initialSettings.currencyCode
  )
  const [labelRegion, setLabelRegion] = React.useState<LabelRegion>(
    initialSettings.labelRegion
  )
  const [wage, setWage] = React.useState(
    centsToDollarInput(initialSettings.wagePerHourCents)
  )
  const [foodCostTargetPercent, setFoodCostTargetPercent] = React.useState(() =>
    String(resolveFoodCostTarget(initialSettings.foodCostTarget) * 100)
  )
  const [overtimeHours, setOvertimeHours] = React.useState(() =>
    String(
      resolveOvertimeWeeklyMinutes(initialSettings.overtimeWeeklyMinutes) / 60
    )
  )
  const [payrollTaxPercent, setPayrollTaxPercent] = React.useState(() =>
    String(resolvePayrollTaxPercent(initialSettings.payrollTaxPercent))
  )
  // The switch is derived state, not stored: zero minutes *is* off. Keeping a
  // separate boolean would let the two disagree, and a workspace would then
  // read "on" while deducting nothing.
  const [breakMinutes, setBreakMinutes] = React.useState(() =>
    String(resolveUnpaidBreakMinutes(initialSettings.unpaidBreakMinutes))
  )
  const [breakPerHours, setBreakPerHours] = React.useState(() =>
    String(resolveUnpaidBreakPerHours(initialSettings.unpaidBreakPerHours))
  )
  const [breakEnabled, setBreakEnabled] = React.useState(
    () => resolveUnpaidBreakMinutes(initialSettings.unpaidBreakMinutes) > 0
  )
  const [timezone, setTimezone] = React.useState(initialSettings.timezone)
  // A zone saved through the API need not be one the curated list offers; it
  // still has to appear, or the trigger renders blank on its own setting.
  const timezoneChoices = React.useMemo(
    () =>
      TIMEZONE_OPTIONS.includes(
        initialSettings.timezone as (typeof TIMEZONE_OPTIONS)[number]
      )
        ? [...TIMEZONE_OPTIONS]
        : [initialSettings.timezone, ...TIMEZONE_OPTIONS],
    [initialSettings.timezone]
  )
  const timezoneLabels = React.useMemo(
    () =>
      Object.fromEntries(
        timezoneChoices.map((zone) => [zone, timezoneLabel(zone)])
      ),
    [timezoneChoices]
  )
  const [quoting, setQuoting] = React.useState(false)
  const [quoteError, setQuoteError] = React.useState<string | null>(null)
  const [quote, setQuote] = React.useState<CurrencyConversionQuote | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const wagePerHourCents = dollarsToCents(wage)
  const parsedFoodCostTargetPercent = Number(foodCostTargetPercent)
  const validFoodCostTarget =
    foodCostTargetPercent.trim() !== "" &&
    Number.isFinite(parsedFoodCostTargetPercent) &&
    parsedFoodCostTargetPercent >= 1 &&
    parsedFoodCostTargetPercent <= 100
  const foodCostTarget = parsedFoodCostTargetPercent / 100
  const parsedOvertimeHours = Number(overtimeHours)
  const validOvertimeHours =
    overtimeHours.trim() !== "" &&
    Number.isFinite(parsedOvertimeHours) &&
    parsedOvertimeHours >= 1 &&
    parsedOvertimeHours <= 168
  const overtimeWeeklyMinutes = Math.round(parsedOvertimeHours * 60)
  const parsedPayrollTaxPercent = Number(payrollTaxPercent)
  const validPayrollTax =
    payrollTaxPercent.trim() !== "" &&
    Number.isFinite(parsedPayrollTaxPercent) &&
    parsedPayrollTaxPercent >= 0 &&
    parsedPayrollTaxPercent <= 200
  const parsedBreakMinutes = Number(breakMinutes)
  const parsedBreakPerHours = Number(breakPerHours)
  // Only checked while the rule is on: switching it off should not be blocked
  // by whatever half-typed number the fields were left holding.
  const validBreakMinutes =
    !breakEnabled ||
    (breakMinutes.trim() !== "" &&
      Number.isInteger(parsedBreakMinutes) &&
      parsedBreakMinutes >= 1 &&
      parsedBreakMinutes <= 480)
  const validBreakPerHours =
    !breakEnabled ||
    (breakPerHours.trim() !== "" &&
      Number.isInteger(parsedBreakPerHours) &&
      parsedBreakPerHours >= 1 &&
      parsedBreakPerHours <= 24)
  // Off is stored as zero minutes, which is what the backend reads as off.
  const unpaidBreakMinutes = breakEnabled ? parsedBreakMinutes : 0
  const currencyChanged = currencyCode !== initialSettings.currencyCode

  const problems = (): FormErrors => ({
    ...(wagePerHourCents === null
      ? { [WAGE_FIELD]: "Enter a valid hourly rate." }
      : {}),
    ...(validFoodCostTarget
      ? {}
      : { [FOOD_COST_FIELD]: "Enter a food cost target from 1% to 100%." }),
    ...(validOvertimeHours
      ? {}
      : { [OVERTIME_FIELD]: "Enter a weekly threshold from 1 to 168 hours." }),
    ...(validPayrollTax
      ? {}
      : { [PAYROLL_TAX_FIELD]: "Enter a payroll tax from 0% to 200%." }),
    ...(validBreakMinutes
      ? {}
      : { [BREAK_MINUTES_FIELD]: "Enter 1 to 480 minutes." }),
    ...(validBreakPerHours
      ? {}
      : { [BREAK_HOURS_FIELD]: "Enter 1 to 24 hours." }),
  })

  const form = useFormSave({
    snapshot: JSON.stringify([
      measurementSystem,
      currencyCode,
      labelRegion,
      timezone,
      wage,
      foodCostTargetPercent,
      overtimeHours,
      payrollTaxPercent,
      breakEnabled,
      breakMinutes,
      breakPerHours,
    ]),
    validate: problems,
    save: async () => {
      const result = await updateBusinessSettings({
        wagePerHourCents: wagePerHourCents!,
        measurementSystem,
        currencyCode,
        labelRegion,
        timezone,
        foodCostTarget,
        overtimeWeeklyMinutes,
        payrollTaxPercent: parsedPayrollTaxPercent,
        unpaidBreakMinutes,
        unpaidBreakPerHours: parsedBreakPerHours,
        expectedCurrencyCode: initialSettings.currencyCode,
        confirmCurrencyConversion: quote !== null,
        quotedRate: quote?.rate,
        quotedRateDate: quote?.rateDate,
      })
      return "error" in result ? toSaveFailure(result) : null
    },
  })
  const { confirm, dialog } = useDirtyDialog()

  const loadQuote = async () => {
    setQuoting(true)
    setQuoteError(null)
    try {
      setQuote(
        await getCurrencyConversionQuote(
          currencyCode,
          initialSettings.currencyCode
        )
      )
      setConfirmOpen(true)
    } catch {
      setQuoteError("Couldn’t load the exchange rate. Try again.")
    } finally {
      setQuoting(false)
    }
  }

  // The rate is quoted and confirmed before anything is written, so the
  // conversion the dialog names is the conversion that runs.
  const submit = () => {
    if (currencyChanged && quote === null) {
      if (Object.keys(problems()).length === 0) {
        void loadQuote()
        return
      }
    }
    void form.submit().then((done) => {
      if (!done) return
      setConfirmOpen(false)
      onOpenChange(false)
    })
  }

  const dismiss = () => confirm(form.dirty, () => onOpenChange(false))

  const wageSymbol = currencySymbol(
    currencyChanged ? initialSettings.currencyCode : currencyCode
  )
  const payrollAverage = initialSettings.payrollAverageRateCents

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) dismiss()
        }}
      >
        <DialogContent onKeyDown={dialogSaveShortcut(submit)}>
          <DialogHeader>
            <DialogTitle>Business defaults</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <FieldGroup className="gap-4">
              <Field>
                <LabeledShell label="Measurement system">
                  <Select
                    items={MEASUREMENT_SYSTEM_LABELS}
                    value={measurementSystem}
                    onValueChange={(value) =>
                      setMeasurementSystem(value as MeasurementSystem)
                    }
                  >
                    <SelectTrigger
                      id="measurement-system"
                      aria-label="Measurement system"
                      className={labeledControlClassName}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="metric">
                        {MEASUREMENT_SYSTEM_LABELS.metric}
                      </SelectItem>
                      <SelectItem value="us">
                        {MEASUREMENT_SYSTEM_LABELS.us}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledShell>
                <FieldDescription>
                  Sets the units shown in forms and weights. Stored weights stay
                  exact in grams.
                </FieldDescription>
              </Field>

              <Field>
                <LabeledShell label="Label region">
                  <Select
                    items={LABEL_REGION_LABELS}
                    value={labelRegion}
                    onValueChange={(value) =>
                      setLabelRegion(value as LabelRegion)
                    }
                  >
                    <SelectTrigger
                      id="label-region"
                      aria-label="Label region"
                      className={labeledControlClassName}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LABEL_REGIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {LABEL_REGION_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LabeledShell>
                <FieldDescription>
                  Which labelling rules the kitchen works to. It picks the
                  allergen tags the screens lead with and how the label preview
                  declares them.
                </FieldDescription>
              </Field>

              <Field>
                <LabeledShell label="Timezone">
                  <Select
                    items={timezoneLabels}
                    value={timezone}
                    onValueChange={(value) => setTimezone(value as string)}
                  >
                    <SelectTrigger
                      id="timezone"
                      aria-label="Timezone"
                      className={labeledControlClassName}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timezoneChoices.map((option) => (
                        <SelectItem key={option} value={option}>
                          {timezoneLabels[option]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LabeledShell>
                <FieldDescription>
                  The zone the kitchen works in. Every date and time the app
                  shows is read in it, so a late shift stays on the day it was
                  worked rather than the day the server saw it.
                </FieldDescription>
              </Field>

              <Field>
                <LabeledShell label="Currency">
                  <Select
                    items={CURRENCY_LABELS}
                    value={currencyCode}
                    onValueChange={(value) => {
                      setCurrencyCode(value as CurrencyCode)
                      setQuote(null)
                    }}
                  >
                    <SelectTrigger
                      id="currency-code"
                      aria-label="Currency"
                      className={labeledControlClassName}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_OPTIONS.map((currency) => (
                        <SelectItem key={currency.code} value={currency.code}>
                          {CURRENCY_LABELS[currency.code]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </LabeledShell>
                <FieldDescription>
                  Changing currency converts saved costs once, at the latest
                  daily rate. You review the rate first.
                </FieldDescription>
              </Field>

              <Field>
                {/* Units ride in the floated label, not as affixes. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <LabeledInput
                    label={`Average labor rate (${wageSymbol} / hour)`}
                    id={WAGE_FIELD}
                    inputMode="decimal"
                    value={wage}
                    aria-invalid={Boolean(form.errors[WAGE_FIELD]) || undefined}
                    className="tabular-nums"
                    onChange={(event) => setWage(event.target.value)}
                  />
                  <LabeledInput
                    label="Food cost target (%)"
                    id={FOOD_COST_FIELD}
                    inputMode="decimal"
                    value={foodCostTargetPercent}
                    aria-invalid={
                      Boolean(form.errors[FOOD_COST_FIELD]) || undefined
                    }
                    className="tabular-nums"
                    onChange={(event) =>
                      setFoodCostTargetPercent(event.target.value)
                    }
                  />
                </div>
                {payrollAverage !== null ? (
                  <p className="text-xs text-muted-foreground">
                    {`Payroll average: ${formatCents(payrollAverage, initialSettings.currencyCode)}/h`}{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      onClick={() =>
                        setWage(centsToDollarInput(payrollAverage))
                      }
                    >
                      Use
                    </button>
                  </p>
                ) : null}
                <FieldDescription>
                  Wage plus payroll taxes and benefits. Recipes above the target
                  are flagged across Analytics and Recipes.
                </FieldDescription>
                {form.errors[WAGE_FIELD] ? (
                  <FieldError>{form.errors[WAGE_FIELD]}</FieldError>
                ) : null}
                {form.errors[FOOD_COST_FIELD] ? (
                  <FieldError>{form.errors[FOOD_COST_FIELD]}</FieldError>
                ) : null}
              </Field>

              <Field>
                <LabeledInput
                  label="Payroll tax and burden (%)"
                  id={PAYROLL_TAX_FIELD}
                  inputMode="decimal"
                  value={payrollTaxPercent}
                  aria-invalid={
                    Boolean(form.errors[PAYROLL_TAX_FIELD]) || undefined
                  }
                  className="tabular-nums"
                  onChange={(event) => setPayrollTaxPercent(event.target.value)}
                />
                <FieldDescription>
                  What you pay on top of a wage — payroll taxes, statutory
                  contributions, benefits. Labor reports it beside the wage as
                  the incremental, so the two never blur into one figure. Leave
                  it at 0 to report bare wages.
                </FieldDescription>
                {form.errors[PAYROLL_TAX_FIELD] ? (
                  <FieldError>{form.errors[PAYROLL_TAX_FIELD]}</FieldError>
                ) : null}
                <PayrollBurdenEstimator
                  wagePerHourCents={
                    wagePerHourCents ?? initialSettings.wagePerHourCents
                  }
                  onApply={(burden) => setPayrollTaxPercent(String(burden))}
                />
              </Field>

              <Field>
                <div className="flex items-center gap-3">
                  <span
                    id="unpaid-break-label"
                    className="min-w-0 flex-1 text-md text-foreground"
                  >
                    Deduct an unpaid break
                  </span>
                  <Switch
                    checked={breakEnabled}
                    onCheckedChange={setBreakEnabled}
                    aria-label="Deduct an unpaid break"
                    aria-describedby="unpaid-break-label"
                  />
                </div>
                {breakEnabled ? (
                  <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <LabeledInput
                      label="Minutes deducted"
                      id={BREAK_MINUTES_FIELD}
                      inputMode="numeric"
                      value={breakMinutes}
                      aria-invalid={
                        Boolean(form.errors[BREAK_MINUTES_FIELD]) || undefined
                      }
                      className="tabular-nums"
                      onChange={(event) => setBreakMinutes(event.target.value)}
                    />
                    <LabeledInput
                      label="Per hours worked"
                      id={BREAK_HOURS_FIELD}
                      inputMode="numeric"
                      value={breakPerHours}
                      aria-invalid={
                        Boolean(form.errors[BREAK_HOURS_FIELD]) || undefined
                      }
                      className="tabular-nums"
                      onChange={(event) => setBreakPerHours(event.target.value)}
                    />
                  </div>
                ) : null}
                <FieldDescription>
                  {breakEnabled && validBreakMinutes && validBreakPerHours
                    ? `Whole blocks only: a shift under ${parsedBreakPerHours}h loses nothing, ${parsedBreakPerHours}h to ${parsedBreakPerHours * 2 - 1}h loses ${parsedBreakMinutes} minutes, ${parsedBreakPerHours * 2}h loses ${parsedBreakMinutes * 2}. Clocked hours stay as imported; only pay changes. Saving re-costs every shift you already have.`
                    : "Off by default — shifts cost exactly the hours your timesheet reports. Turn it on if your kitchen takes a meal break off every shift."}
                </FieldDescription>
                {form.errors[BREAK_MINUTES_FIELD] ? (
                  <FieldError>{form.errors[BREAK_MINUTES_FIELD]}</FieldError>
                ) : null}
                {form.errors[BREAK_HOURS_FIELD] ? (
                  <FieldError>{form.errors[BREAK_HOURS_FIELD]}</FieldError>
                ) : null}
              </Field>

              <Field>
                <LabeledInput
                  label="Weekly overtime threshold (hours)"
                  id={OVERTIME_FIELD}
                  inputMode="decimal"
                  value={overtimeHours}
                  aria-invalid={
                    Boolean(form.errors[OVERTIME_FIELD]) || undefined
                  }
                  className="tabular-nums"
                  onChange={(event) => setOvertimeHours(event.target.value)}
                />
                <FieldDescription>
                  Employees are flagged on Labor when a Sunday–Saturday week
                  goes past this.
                </FieldDescription>
                {form.errors[OVERTIME_FIELD] ? (
                  <FieldError>{form.errors[OVERTIME_FIELD]}</FieldError>
                ) : null}
              </Field>

              {(quoteError ?? form.failure) ? (
                <FieldError>{quoteError ?? form.failure?.message}</FieldError>
              ) : null}
            </FieldGroup>

            <DialogFooter className="mt-[18px]">
              <Button type="button" variant="outline" onClick={dismiss}>
                Cancel
              </Button>
              <Button type="submit" pending={form.pending || quoting}>
                {quoting ? "Loading rate…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
          {dialog}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen && quote !== null}
        onOpenChange={(next) => {
          setConfirmOpen(next)
          // Dropping the quote makes the next Save re-quote and re-confirm.
          if (!next) setQuote(null)
        }}
        variant="default"
        pending={form.pending}
        title={`Convert ${initialSettings.currencyCode} to ${currencyCode}?`}
        confirmLabel={form.pending ? "Converting…" : "Convert and save"}
        description={
          <>
            This converts ingredient and supplier prices, price history, menu
            prices, recipe costs, and your hourly rate once. Later rate moves
            leave them alone.
            {quote ? (
              <span className="mt-2 block text-foreground tabular-nums">
                1 {quote.sourceCurrency} ={" "}
                {new Intl.NumberFormat("en-US", {
                  maximumFractionDigits: 6,
                }).format(Number(quote.rate))}{" "}
                {quote.targetCurrency}
                <span className="block text-muted-foreground">
                  {quote.provider} reference rate · {quote.rateDate}
                </span>
              </span>
            ) : null}
          </>
        }
        onConfirm={submit}
      />
    </>
  )
}
