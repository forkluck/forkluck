"use server"

import { revalidatePath } from "next/cache"
import * as XLSX from "xlsx"
import { z } from "zod"

import { requireUser } from "@/lib/auth-session"
import { actionErrorMessage } from "@/lib/backend/action-error"
import { djangoAction } from "@/lib/backend/client"
import {
  assertArchiveWithinBudget,
  readFirstSheetRows,
} from "@/lib/import-limits"
import {
  parseLaborRows,
  type LaborColumnMap,
  type LaborImportPerson,
  type LaborImportPreview,
} from "@/lib/labor-import"

const columnMapSchema = z.object({
  employee: z.string().min(1).max(200),
  clockIn: z.string().min(1).max(200),
  clockOut: z.string().min(1).max(200),
  duration: z.string().min(1).max(200).nullable(),
  breaks: z.string().min(1).max(200).nullable(),
  timeAdjustment: z.string().min(1).max(200).nullable(),
  earningsAdjustment: z.string().min(1).max(200).nullable(),
  comment: z.string().min(1).max(200).nullable(),
})

export type LaborPreviewPerson = LaborImportPerson & {
  employeeId: string | null
  hourlyRateCents: number | null
  rateEffectiveFrom: string | null
}

export type LaborFilePreview = Omit<LaborImportPreview, "people"> & {
  people: LaborPreviewPerson[]
  timezone: string
}

export async function parseLaborFile(
  base64: string,
  fileName: string,
  timezone: string,
  mapping?: LaborColumnMap
): Promise<LaborFilePreview | { error: string }> {
  await requireUser()
  const raw = z.string().min(1).max(8_000_000).parse(base64)
  z.string().trim().min(1).max(255).parse(fileName)
  const safeTimezone = z.string().trim().min(1).max(64).parse(timezone)
  const safeMapping = mapping ? columnMapSchema.parse(mapping) : undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: safeTimezone }).format()
    const bytes = Buffer.from(raw, "base64")
    // Bound the archive from its own directory before SheetJS inflates it.
    assertArchiveWithinBudget(bytes)
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellDates: true,
    })
    const rows = readFirstSheetRows(workbook, {
      header: 1,
      raw: false,
      defval: "",
    })
    if (!rows) return { error: "The file has no sheets." }
    const preview = parseLaborRows(rows, { mapping: safeMapping })
    const status = await djangoAction<{
      items: Array<{
        normalizedName: string
        employeeId: string | null
        hourlyRateCents: number | null
        rateEffectiveFrom: string | null
      }>
    }>("labor-import-status", {
      people: preview.people.map((person) => ({
        name: person.name,
        effectiveOn: person.firstDate,
      })),
    })
    const statusByName = new Map(
      status.items.map((item) => [item.normalizedName, item])
    )
    return {
      ...preview,
      timezone: safeTimezone,
      people: preview.people.map((person) => ({
        ...person,
        employeeId: statusByName.get(person.normalizedName)?.employeeId ?? null,
        hourlyRateCents:
          statusByName.get(person.normalizedName)?.hourlyRateCents ?? null,
        rateEffectiveFrom:
          statusByName.get(person.normalizedName)?.rateEffectiveFrom ?? null,
      })),
    }
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t read that hours file."),
    }
  }
}

const laborEntrySchema = z.object({
  position: z.number().int().min(1).max(1_000_000),
  employeeName: z.string().trim().min(1).max(150),
  clockInLocal: z.string().min(1).max(32),
  clockOutLocal: z.string().min(1).max(32),
  paidSeconds: z.number().int().min(1).max(604_800),
  breakSeconds: z.number().int().min(0).max(604_800),
  timeAdjustmentSeconds: z.number().int().min(-604_800).max(604_800),
  earningsAdjustmentCents: z.number().int().min(-100_000_000).max(100_000_000),
  comment: z.string().max(500),
  raw: z.record(z.string().max(200), z.string().max(2000)),
})

const importLaborSchema = z.object({
  expectedCurrencyCode: z.string().length(3),
  fileName: z.string().trim().min(1).max(255),
  source: z.string().trim().min(1).max(32),
  timezone: z.string().trim().min(1).max(64),
  mapping: columnMapSchema,
  totalRows: z.number().int().min(1).max(1_000_000),
  skippedCount: z.number().int().min(0).max(1_000_000),
  excludedCount: z.number().int().min(0).max(1_000_000),
  entries: z.array(laborEntrySchema).min(1).max(5000),
  rates: z
    .array(
      z.object({
        employeeName: z.string().trim().min(1).max(150),
        hourlyRateCents: z.number().int().min(0).max(100_000_000),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
    )
    .max(500),
})

export type LaborImportReceipt = {
  batchId: string
  imported: number
  createdEmployees: number
  duplicates: number
  skipped: number
  excluded: number
  totalSeconds: number
  totalLaborCostCents: number
  uncosted: number
}

export async function importLabor(
  input: z.input<typeof importLaborSchema>
): Promise<LaborImportReceipt | { error: string }> {
  await requireUser()
  const parsed = importLaborSchema.safeParse(input)
  if (!parsed.success) return { error: "Labor import data looks malformed." }
  try {
    const result = await djangoAction<LaborImportReceipt>(
      "import-labor",
      parsed.data
    )
    revalidatePath("/labor")
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t import those hours.") }
  }
}

const employeeRateSchema = z.object({
  expectedCurrencyCode: z.string().length(3),
  employeeId: z.string().uuid(),
  hourlyRateCents: z.number().int().min(0).max(100_000_000),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export async function setEmployeeRate(
  input: z.input<typeof employeeRateSchema>
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const parsed = employeeRateSchema.safeParse(input)
  if (!parsed.success) return { error: "Hourly rate looks malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "set-employee-rate",
      parsed.data
    )
    revalidatePath("/labor")
    revalidatePath(`/labor/${parsed.data.employeeId}`)
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save that rate.") }
  }
}

const timeEntryRateSchema = z.object({
  expectedCurrencyCode: z.string().length(3),
  entryId: z.string().uuid(),
  hourlyRateCents: z.number().int().min(0).max(100_000_000),
})

export async function setTimeEntryRate(
  input: z.input<typeof timeEntryRateSchema>
): Promise<{ ok: true; employeeId: string } | { error: string }> {
  await requireUser()
  const parsed = timeEntryRateSchema.safeParse(input)
  if (!parsed.success) return { error: "Hourly rate looks malformed." }
  try {
    const result = await djangoAction<{ ok: true; employeeId: string }>(
      "set-time-entry-rate",
      parsed.data
    )
    revalidatePath("/labor")
    revalidatePath(`/labor/${result.employeeId}`)
    return result
  } catch (cause) {
    return { error: actionErrorMessage(cause, "Couldn’t save that rate.") }
  }
}

const employeeActiveSchema = z.object({
  employeeId: z.string().uuid(),
  isActive: z.boolean(),
})

export async function setEmployeeActive(
  input: z.input<typeof employeeActiveSchema>
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const parsed = employeeActiveSchema.safeParse(input)
  if (!parsed.success) return { error: "Employee status looks malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "set-employee-active",
      parsed.data
    )
    revalidatePath("/labor")
    revalidatePath(`/labor/${parsed.data.employeeId}`)
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t update that employee."),
    }
  }
}

const employeeExcludedSchema = z.object({
  employeeId: z.string().uuid(),
  excludedFromCost: z.boolean(),
})

export async function setEmployeeExcludedFromCost(
  input: z.input<typeof employeeExcludedSchema>
): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const parsed = employeeExcludedSchema.safeParse(input)
  if (!parsed.success) return { error: "Employee costing looks malformed." }
  try {
    const result = await djangoAction<{ ok: true }>(
      "set-employee-excluded-from-cost",
      parsed.data
    )
    revalidatePath("/labor")
    revalidatePath(`/labor/${parsed.data.employeeId}`)
    return result
  } catch (cause) {
    return {
      error: actionErrorMessage(cause, "Couldn’t update that employee."),
    }
  }
}

export async function undoLaborImport(id: string): Promise<{
  ok: true
  deletedEntries: number
  deletedEmployees: number
  retainedEmployees: number
}> {
  await requireUser()
  const result = await djangoAction<{
    ok: true
    deletedEntries: number
    deletedEmployees: number
    retainedEmployees: number
  }>("undo-labor-import", { id: z.string().uuid().parse(id) })
  revalidatePath("/labor")
  return result
}
