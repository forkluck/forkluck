"use client"

import * as React from "react"
import { CloudUpload, TriangleAlert } from "lucide-react"

import {
  importLabor,
  parseLaborFile,
  type LaborFilePreview,
  type LaborImportReceipt,
} from "@/app/(app)/labor/actions"
import {
  formatDecimalHours,
  formatWorkedHours,
} from "@/components/labor/labor-format"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  LabeledShell,
  labeledControlClassName,
} from "@/components/ui/labeled-field"
import { Input, InputAffix, InputGroup } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { centsToDollarInput, dollarsToCents, formatCents } from "@/lib/money"
import { readAsBase64 } from "@/lib/client-file"
import { normalizeEmployeeName, type LaborColumnMap } from "@/lib/labor-import"
import { currencySymbol } from "@/lib/business-settings"
import { cn } from "@/lib/utils"
import { useRefresh } from "@/hooks/use-refresh"

const localDateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

function formatLocalDateTime(value: string) {
  return localDateTimeFormat.format(new Date(`${value}Z`))
}

/** The sentinel a Base UI select needs for "this column is not in the file". */
const NO_COLUMN = "__none__"

function ColumnSelect({
  label,
  headers,
  value,
  optional = false,
  disabled,
  onChange,
}: {
  label: string
  headers: string[]
  value: string | null
  optional?: boolean
  disabled: boolean
  onChange: (value: string | null) => void
}) {
  return (
    <LabeledShell label={label}>
      <Select
        value={value ?? NO_COLUMN}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(next === NO_COLUMN ? null : (next as string))
        }
      >
        <SelectTrigger
          aria-label={label}
          className={cn(labeledControlClassName, "justify-between text-sm")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {optional ? (
            <SelectItem value={NO_COLUMN}>Not included</SelectItem>
          ) : null}
          {headers.map((header) => (
            <SelectItem key={header} value={header}>
              {header}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </LabeledShell>
  )
}

/** A figure and its label inside one of the inset summary panels. */
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-md font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function ImportReceiptView({
  receipt,
  onDone,
}: {
  receipt: LaborImportReceipt
  onDone: () => void
}) {
  const { currencyCode } = useBusinessSettings()
  const notes = [
    receipt.duplicates
      ? `${receipt.duplicates} duplicate ${receipt.duplicates === 1 ? "row" : "rows"} ignored`
      : null,
    receipt.skipped
      ? `${receipt.skipped} unreadable ${receipt.skipped === 1 ? "row" : "rows"} left out`
      : null,
    receipt.excluded
      ? `${receipt.excluded} ${receipt.excluded === 1 ? "row" : "rows"} intentionally excluded`
      : null,
  ].filter((note): note is string => note !== null)

  return (
    <>
      <div className="rounded-lg border border-border bg-fill-soft p-4">
        <p className="text-md font-semibold">Hours imported</p>
        <p className="mt-1 text-xs leading-[1.55] text-muted-foreground">
          The original rows and the rate used for every cost are kept, so this
          import can be undone from the import history.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-muted pt-4 sm:grid-cols-4">
          <Stat label="Shifts" value={receipt.imported} />
          <Stat
            label="Hours"
            value={formatDecimalHours(receipt.totalSeconds)}
          />
          <Stat
            label="Labor cost"
            value={formatCents(receipt.totalLaborCostCents, currencyCode)}
          />
          <Stat label="Needs a rate" value={receipt.uncosted} />
        </dl>
        {notes.length ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {notes.join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="mt-0.5 flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  )
}

function ImportBody({ onDone }: { onDone: () => void }) {
  const { refresh } = useRefresh()
  const { currencyCode } = useBusinessSettings()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [fileName, setFileName] = React.useState("")
  const [fileData, setFileData] = React.useState("")
  const [preview, setPreview] = React.useState<LaborFilePreview | null>(null)
  const [rates, setRates] = React.useState<Record<string, string>>({})
  const [included, setIncluded] = React.useState<Record<string, boolean>>({})
  const [receipt, setReceipt] = React.useState<LaborImportReceipt | null>(null)
  const [over, setOver] = React.useState(false)

  const applyPreview = (next: LaborFilePreview, resetSelection = false) => {
    setPreview(next)
    setIncluded((current) =>
      Object.fromEntries(
        next.people.map((person) => [
          person.normalizedName,
          resetSelection ? true : (current[person.normalizedName] ?? true),
        ])
      )
    )
    setRates((current) =>
      Object.fromEntries(
        next.people.map((person) => [
          person.normalizedName,
          current[person.normalizedName] ??
            (person.hourlyRateCents === null
              ? ""
              : centsToDollarInput(person.hourlyRateCents)),
        ])
      )
    )
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setPreview(null)
    setReceipt(null)
    setIncluded({})
    setFileName(file.name)
    try {
      const base64 = await readAsBase64(file)
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      const result = await parseLaborFile(base64, file.name, timezone)
      setFileData(base64)
      if ("error" in result) {
        setError(result.error)
      } else if (result.entries.length === 0) {
        setError("No usable shifts were found in that file.")
      } else {
        applyPreview(result, true)
      }
    } catch {
      setError("Couldn’t read that file — try exporting it as CSV.")
    } finally {
      setBusy(false)
    }
  }

  const remap = async (mapping: LaborColumnMap) => {
    if (!fileData || !fileName || !preview) return
    setBusy(true)
    setError(null)
    try {
      const result = await parseLaborFile(
        fileData,
        fileName,
        preview.timezone,
        mapping
      )
      if ("error" in result) setError(result.error)
      else applyPreview(result)
    } catch {
      setError("Couldn’t apply that column mapping.")
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview) return
    if (includedEntries.length === 0) {
      setError("Include at least one employee before importing.")
      return
    }
    const rateEntries: Array<{
      employeeName: string
      hourlyRateCents: number
      effectiveFrom: string
    }> = []
    for (const person of includedPeople) {
      const rawRate = rates[person.normalizedName]?.trim() ?? ""
      if (!rawRate) continue
      const cents = dollarsToCents(rawRate)
      if (cents === null) {
        setError(`Enter a valid hourly rate for ${person.name}.`)
        return
      }
      if (person.hourlyRateCents === cents) continue
      rateEntries.push({
        employeeName: person.name,
        hourlyRateCents: cents,
        effectiveFrom: person.firstDate,
      })
    }

    setBusy(true)
    setError(null)
    try {
      const result = await importLabor({
        expectedCurrencyCode: currencyCode,
        fileName,
        source: "csv",
        timezone: preview.timezone,
        mapping: preview.mapping,
        totalRows: preview.totalRows,
        skippedCount: preview.skipped.length,
        excludedCount,
        entries: includedEntries,
        rates: rateEntries,
      })
      if ("error" in result) {
        setError(result.error)
      } else {
        setReceipt(result)
        await refresh()
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The import failed — check your connection and try again."
      )
    } finally {
      setBusy(false)
    }
  }

  const includedPeople =
    preview?.people.filter(
      (person) => included[person.normalizedName] !== false
    ) ?? []
  const includedNames = new Set(
    includedPeople.map((person) => person.normalizedName)
  )
  const includedEntries =
    preview?.entries.filter((entry) =>
      includedNames.has(normalizeEmployeeName(entry.employeeName))
    ) ?? []
  const includedSeconds = includedEntries.reduce(
    (total, entry) => total + entry.paidSeconds,
    0
  )
  const excludedCount = preview
    ? preview.entries.length - includedEntries.length
    : 0
  const missingRates = includedPeople.filter(
    (person) => !(rates[person.normalizedName] ?? "").trim()
  ).length

  if (receipt) return <ImportReceiptView receipt={receipt} onDone={onDone} />

  return (
    <>
      <div className="flex min-h-0 flex-col gap-3">
        {/* The drop zone: 1.5px dashed line, radius 12, the inset fill. */}
        <label
          htmlFor="labor-import-file"
          // The input inside is visually hidden but still focusable, so the
          // dashed edge is what shows keyboard focus — there are no rings here.
          onDragOver={(event) => {
            if (busy) return
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            if (busy) return
            void pick(event.dataTransfer.files[0])
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed bg-fill-soft px-6 py-8 text-center has-[input:focus-visible]:border-foreground",
            over ? "border-foreground bg-muted" : "border-line-strong"
          )}
        >
          <CloudUpload
            className="size-5 text-muted-foreground"
            strokeWidth={1.6}
            aria-hidden="true"
          />
          <span className="text-md font-medium">
            {fileName || "Drop a timesheet here, or browse"}
          </span>
          <span className="text-sm text-muted-foreground">
            CSV or XLSX, up to 10 MB
          </span>
          <input
            id="labor-import-file"
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            disabled={busy}
            className="sr-only"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </label>

        {preview ? (
          <div className="rounded-lg border border-border bg-fill-soft p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-md font-medium">{fileName}</p>
              <Badge>{preview.timezone}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {preview.periodStart} – {preview.periodEnd}
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-muted pt-4 sm:grid-cols-4">
              <Stat label="Ready" value={includedEntries.length} />
              <Stat label="Employees" value={includedPeople.length} />
              <Stat label="Hours" value={formatDecimalHours(includedSeconds)} />
              <Stat label="Excluded" value={excludedCount} />
            </dl>
          </div>
        ) : null}

        {preview ? (
          <details className="rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              Column mapping
              <span className="font-normal text-muted-foreground">
                {preview.mapping.employee} → Employee
              </span>
            </summary>
            <div className="grid gap-4 border-t border-muted p-4 sm:grid-cols-2 lg:grid-cols-4">
              <ColumnSelect
                label="Employee"
                headers={preview.headers}
                value={preview.mapping.employee}
                disabled={busy}
                onChange={(value) => {
                  if (value) void remap({ ...preview.mapping, employee: value })
                }}
              />
              <ColumnSelect
                label="Clock in"
                headers={preview.headers}
                value={preview.mapping.clockIn}
                disabled={busy}
                onChange={(value) => {
                  if (value) void remap({ ...preview.mapping, clockIn: value })
                }}
              />
              <ColumnSelect
                label="Clock out"
                headers={preview.headers}
                value={preview.mapping.clockOut}
                disabled={busy}
                onChange={(value) => {
                  if (value) void remap({ ...preview.mapping, clockOut: value })
                }}
              />
              <ColumnSelect
                label="Paid duration"
                headers={preview.headers}
                value={preview.mapping.duration}
                optional
                disabled={busy}
                onChange={(value) =>
                  void remap({ ...preview.mapping, duration: value })
                }
              />
              <ColumnSelect
                label="Breaks"
                headers={preview.headers}
                value={preview.mapping.breaks}
                optional
                disabled={busy}
                onChange={(value) =>
                  void remap({ ...preview.mapping, breaks: value })
                }
              />
              <ColumnSelect
                label="Time adjustment"
                headers={preview.headers}
                value={preview.mapping.timeAdjustment}
                optional
                disabled={busy}
                onChange={(value) =>
                  void remap({ ...preview.mapping, timeAdjustment: value })
                }
              />
              <ColumnSelect
                label="Earnings adjustment"
                headers={preview.headers}
                value={preview.mapping.earningsAdjustment}
                optional
                disabled={busy}
                onChange={(value) =>
                  void remap({ ...preview.mapping, earningsAdjustment: value })
                }
              />
              <ColumnSelect
                label="Comment"
                headers={preview.headers}
                value={preview.mapping.comment}
                optional
                disabled={busy}
                onChange={(value) =>
                  void remap({ ...preview.mapping, comment: value })
                }
              />
            </div>
          </details>
        ) : null}

        {preview ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-muted px-4 py-3">
              <div>
                <p className="text-md font-semibold">Employees to include</p>
                <p className="mt-1 text-xs leading-[1.55] text-muted-foreground">
                  Uncheck anyone whose shifts should not count. Rates can be set
                  now or later.
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                {excludedCount ? (
                  <Badge>{excludedCount} rows excluded</Badge>
                ) : null}
                {missingRates ? (
                  <Badge variant="warning">{missingRates} rates missing</Badge>
                ) : (
                  <Badge variant="success">Ready</Badge>
                )}
              </div>
            </div>
            <div className="max-h-56 overflow-auto">
              {preview.people.map((person) => {
                const isIncluded = included[person.normalizedName] !== false
                const includeId = `labor-include-${person.normalizedName}`
                return (
                  <div
                    key={person.normalizedName}
                    className="grid gap-3 border-b border-muted px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                  >
                    <label
                      htmlFor={includeId}
                      className="flex min-w-0 cursor-pointer items-start gap-3"
                    >
                      <Checkbox
                        id={includeId}
                        className="mt-0.5"
                        checked={isIncluded}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setIncluded((current) => ({
                            ...current,
                            [person.normalizedName]: checked === true,
                          }))
                        }
                      />
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block truncate text-md",
                            !isIncluded && "text-faint line-through"
                          )}
                        >
                          {person.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {person.shiftCount}{" "}
                          {person.shiftCount === 1 ? "shift" : "shifts"} ·{" "}
                          {formatDecimalHours(person.totalSeconds)} h ·{" "}
                          {person.employeeId ? "Existing" : "New"}
                        </span>
                      </span>
                    </label>
                    <InputGroup>
                      <Label
                        htmlFor={`labor-rate-${person.normalizedName}`}
                        className="sr-only"
                      >
                        Hourly rate for {person.name}
                      </Label>
                      <InputAffix>{currencySymbol(currencyCode)}</InputAffix>
                      <Input
                        id={`labor-rate-${person.normalizedName}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="pr-[62px] pl-6 tabular-nums"
                        value={rates[person.normalizedName] ?? ""}
                        disabled={busy || !isIncluded}
                        onChange={(event) =>
                          setRates((current) => ({
                            ...current,
                            [person.normalizedName]: event.target.value,
                          }))
                        }
                      />
                      <InputAffix side="end" className="text-sm">
                        / hour
                      </InputAffix>
                    </InputGroup>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {preview && includedEntries.length ? (
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-base">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 text-2xs font-medium text-ink-soft">
                    Employee
                  </th>
                  <th className="px-4 py-3 text-2xs font-medium text-ink-soft">
                    Clock in
                  </th>
                  <th className="px-4 py-3 text-2xs font-medium text-ink-soft">
                    Clock out
                  </th>
                  <th className="px-4 py-3 text-right text-2xs font-medium text-ink-soft">
                    Hours
                  </th>
                </tr>
              </thead>
              <tbody>
                {includedEntries.slice(0, 30).map((entry) => (
                  <tr
                    key={`${entry.position}-${entry.employeeName}`}
                    className="border-b border-muted last:border-b-0"
                  >
                    <td className="px-4 py-2.5 text-md">
                      {entry.employeeName}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatLocalDateTime(entry.clockInLocal)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatLocalDateTime(entry.clockOutLocal)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                      {formatWorkedHours(entry.paidSeconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {includedEntries.length > 30 ? (
              <p className="border-t border-muted px-4 py-3 text-xs text-muted-foreground">
                Showing 30 of {includedEntries.length} included shifts.
              </p>
            ) : null}
          </div>
        ) : preview ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-base text-muted-foreground">
            Include at least one employee to preview their shifts.
          </p>
        ) : null}

        {preview?.skipped.length ? (
          <details className="rounded-lg border border-warning-border bg-warning-fill">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-warning-foreground [&::-webkit-details-marker]:hidden">
              <TriangleAlert
                className="size-4 text-warning"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {preview.skipped.length}{" "}
              {preview.skipped.length === 1 ? "row needs" : "rows need"} review
            </summary>
            <div className="max-h-40 overflow-auto border-t border-warning-border">
              {preview.skipped.map((row) => (
                <p
                  key={row.position}
                  className="px-4 py-2 text-xs text-warning-foreground"
                >
                  <span className="font-medium">Row {row.position}</span>
                  {row.employeeName ? ` · ${row.employeeName}` : ""}
                  <span className="ml-2 opacity-80">{row.reason}</span>
                </p>
              ))}
            </div>
          </details>
        ) : null}

        {error ? (
          <p className="text-xs leading-[1.55] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-0.5 flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={busy || !preview || includedEntries.length === 0}
          onClick={() => void confirm()}
        >
          {busy
            ? "Working…"
            : includedEntries.length
              ? `Import ${includedEntries.length} shifts`
              : "Import hours"}
        </Button>
      </div>
    </>
  )
}

/**
 * Import hours — the wide editor modal. Nothing is written until the columns
 * and the per-person rates are confirmed, and the receipt that follows names
 * exactly what landed.
 */
export function ImportHoursDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="p-7">
        <DialogHeader>
          <DialogTitle>Import hours</DialogTitle>
          <DialogDescription className="text-xs leading-[1.55]">
            Upload the timesheet your clock exports. Confirm the columns and the
            hourly rates before anything is saved.
          </DialogDescription>
        </DialogHeader>
        {open ? <ImportBody onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
