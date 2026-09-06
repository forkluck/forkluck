"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { FieldDescription } from "@/components/ui/field"
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
import {
  FULL_TIME_HOURS_PER_YEAR,
  OTHER_STATE,
  STATE_UNEMPLOYMENT,
  US_FEDERAL,
  estimateBurden,
} from "@/lib/payroll-tax"

const percent = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

/** A `12.5` from a text field, or null when the box does not hold a number. */
function positiveNumber(raw: string): number | null {
  if (raw.trim() === "") return null
  const value = Number(raw.replace(/,/g, ""))
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Works out a US employer's burden as one percent of payroll, and hands it to
 * the payroll tax field.
 *
 * It shows its working rather than printing an answer, because the two
 * unemployment taxes are charged only on the first N dollars each person
 * earns in a year. Adding a 4.1% state rate to 8.25% federal would be wrong
 * by more than half, and a kitchen has no way to see that from a single
 * number — so the wage base and the annual wage are on screen, editable, and
 * visibly doing the work.
 *
 * The state rate is a starting point, never an answer: a state assigns each
 * employer their own rate from claims history and industry, and the annual
 * notice is the only place the real one exists. The picker lists the states
 * whose published new-employer figures we carry; every other kitchen types
 * the two numbers off that notice.
 */
export function PayrollBurdenEstimator({
  /** The workspace's average hourly wage in cents, to seed an annual wage. */
  wagePerHourCents,
  onApply,
}: {
  wagePerHourCents: number
  onApply: (burdenPercent: number) => void
}) {
  const [stateCode, setStateCode] = React.useState<string>(
    STATE_UNEMPLOYMENT[0]?.code ?? OTHER_STATE
  )
  const known = STATE_UNEMPLOYMENT.find((row) => row.code === stateCode)
  const [stateRate, setStateRate] = React.useState(
    String(known?.newEmployerRatePercent ?? "")
  )
  const [wageBase, setWageBase] = React.useState(String(known?.wageBase ?? ""))
  const [annualWage, setAnnualWage] = React.useState(
    String(
      Math.round((wagePerHourCents / 100) * FULL_TIME_HOURS_PER_YEAR) || ""
    )
  )

  const stateOptions = React.useMemo<Record<string, string>>(
    () => ({
      ...Object.fromEntries(
        STATE_UNEMPLOYMENT.map((row) => [row.code, row.name])
      ),
      [OTHER_STATE]: "Another state",
    }),
    []
  )

  // Picking a state fills its published figures in; picking "another state"
  // clears them rather than leaving New York's numbers under a Texas label.
  function chooseState(next: string) {
    setStateCode(next)
    const row = STATE_UNEMPLOYMENT.find((candidate) => candidate.code === next)
    setStateRate(row ? String(row.newEmployerRatePercent) : "")
    setWageBase(row ? String(row.wageBase) : "")
  }

  const parsedRate = positiveNumber(stateRate)
  const parsedBase = positiveNumber(wageBase)
  const parsedWage = positiveNumber(annualWage)
  const ready =
    parsedRate !== null &&
    parsedBase !== null &&
    parsedWage !== null &&
    parsedWage > 0
  const breakdown = ready
    ? estimateBurden({
        stateRatePercent: parsedRate,
        stateWageBase: parsedBase,
        annualWage: parsedWage,
      })
    : null

  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-base font-semibold text-foreground">
        Estimate it for a US kitchen
      </p>

      <div className="mt-3 grid gap-3">
        <LabeledShell label="State">
          <Select
            items={stateOptions}
            value={stateCode}
            onValueChange={(value) => chooseState(value as string)}
          >
            <SelectTrigger
              id="payroll-tax-state"
              aria-label="State"
              className={labeledControlClassName}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...STATE_UNEMPLOYMENT.map((row) => row.code), OTHER_STATE].map(
                (option) => (
                  <SelectItem key={option} value={option}>
                    {stateOptions[option]}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </LabeledShell>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LabeledInput
            label="State unemployment (%)"
            id="payroll-tax-state-rate"
            inputMode="decimal"
            value={stateRate}
            className="tabular-nums"
            onChange={(event) => setStateRate(event.target.value)}
          />
          <LabeledInput
            label="Charged on first ($)"
            id="payroll-tax-wage-base"
            inputMode="decimal"
            value={wageBase}
            className="tabular-nums"
            onChange={(event) => setWageBase(event.target.value)}
          />
        </div>
        <FieldDescription>
          {known
            ? `${known.name}’s published new-employer rate for ${known.year}. Your own rate is assigned to you — take it from your annual rate notice.`
            : "Both numbers are on the rate notice your state sends each year."}
        </FieldDescription>

        <LabeledInput
          label="Typical annual wage per employee ($)"
          id="payroll-tax-annual-wage"
          inputMode="decimal"
          value={annualWage}
          className="tabular-nums"
          onChange={(event) => setAnnualWage(event.target.value)}
        />
        <FieldDescription>
          Unemployment tax stops after the wage base above, so what it costs as
          a share of payroll depends on what a person earns in a year.
        </FieldDescription>
      </div>

      {breakdown ? (
        <>
          <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm tabular-nums">
            <dt className="text-muted-foreground">
              Social Security and Medicare
            </dt>
            <dd className="text-right text-foreground">
              {percent.format(breakdown.ficaPercent)}%
            </dd>
            <dt className="text-muted-foreground">
              Federal unemployment, on the first{" "}
              {money.format(US_FEDERAL.futaWageBase)}
            </dt>
            <dd className="text-right text-foreground">
              {percent.format(breakdown.futaPercent)}%
            </dd>
            <dt className="text-muted-foreground">
              State unemployment, on the first {money.format(parsedBase!)}
            </dt>
            <dd className="text-right text-foreground">
              {percent.format(breakdown.stateUnemploymentPercent)}%
            </dd>
            <dt className="border-t border-border pt-1.5 font-medium text-foreground">
              Estimated burden
            </dt>
            <dd className="border-t border-border pt-1.5 text-right font-medium text-foreground">
              {percent.format(breakdown.totalPercent)}%
            </dd>
          </dl>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => onApply(breakdown.totalPercent)}
          >
            Use {percent.format(breakdown.totalPercent)}%
          </Button>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Fill in the three figures above to see the estimate.
        </p>
      )}
    </div>
  )
}
