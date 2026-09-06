// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const setEmployeeRate = vi.hoisted(() => vi.fn())
const setTimeEntryRate = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/labor/actions", () => ({
  setEmployeeRate,
  setTimeEntryRate,
}))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ currencyCode: "USD" }),
}))

import { EmployeeRateDialog } from "@/components/labor/employee-rate-dialog"
import { TimeEntryRateDialog } from "@/components/labor/time-entry-rate-dialog"
import type { EmployeeRow, TimeEntryRow } from "@/lib/backend/types"

const EMPLOYEE = {
  id: "emp-1",
  name: "Ana Reyes",
  normalizedName: "ana reyes",
  isActive: true,
  excludedFromCost: false,
  currentHourlyRateCents: 2000,
  currentRateEffectiveFrom: "2026-01-01",
  shiftCount: 4,
  totalSeconds: 3600,
  unpaidBreakSeconds: 0,
  laborCostCents: 2000,
  payrollTaxCents: 0,
  uncostedCount: 0,
  firstShiftAt: null,
  lastShiftAt: null,
  rateHistory: [],
} satisfies EmployeeRow

const ENTRY = {
  id: "ent-1",
  employeeId: "emp-1",
  employeeName: "Ana Reyes",
  clockIn: new Date("2026-02-01T15:00:00Z"),
  clockOut: new Date("2026-02-01T20:00:00Z"),
  paidSeconds: 18000,
  unpaidBreakSeconds: 0,
  breakSeconds: 0,
  timeAdjustmentSeconds: 0,
  earningsAdjustmentCents: 0,
  hourlyRateCents: 2000,
  laborCostCents: 10000,
  comment: "",
  importId: "imp-1",
  importTimezone: "UTC",
} satisfies TimeEntryRow

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Hourly rate ($ / hour)"), {
    target: { value },
  })
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
  })
}

describe("the employee rate dialog", () => {
  it("closes only once the save landed", async () => {
    setEmployeeRate.mockResolvedValue({ ok: true })
    const onClose = vi.fn()
    render(
      <EmployeeRateDialog
        employee={EMPLOYEE}
        today="2026-02-01"
        timeZone="UTC"
        onClose={onClose}
      />
    )

    await type("26.00")

    expect(setEmployeeRate).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: "emp-1", hourlyRateCents: 2600 })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it("stays open and says why when the save did not land", async () => {
    setEmployeeRate.mockResolvedValue({ error: "Backend is down" })
    const onClose = vi.fn()
    render(
      <EmployeeRateDialog
        employee={EMPLOYEE}
        today="2026-02-01"
        timeZone="UTC"
        onClose={onClose}
      />
    )

    await type("26.00")

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
  })
})

describe("the shift rate dialog", () => {
  it("closes only once the save landed", async () => {
    setTimeEntryRate.mockResolvedValue({ ok: true })
    const onClose = vi.fn()
    render(
      <TimeEntryRateDialog entry={ENTRY} currencyCode="USD" onClose={onClose} />
    )

    await type("26.00")

    expect(setTimeEntryRate).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "ent-1", hourlyRateCents: 2600 })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it("stays open and says why when the save did not land", async () => {
    setTimeEntryRate.mockResolvedValue({ error: "Backend is down" })
    const onClose = vi.fn()
    render(
      <TimeEntryRateDialog entry={ENTRY} currencyCode="USD" onClose={onClose} />
    )

    await type("26.00")

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
  })
})
