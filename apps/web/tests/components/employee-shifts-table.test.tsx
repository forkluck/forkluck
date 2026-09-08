// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { setTimeEntryRate } = vi.hoisted(() => ({
  setTimeEntryRate: vi.fn(),
}))

vi.mock("@/app/(app)/labor/actions", () => ({
  setTimeEntryRate,
}))

import { EmployeeShiftsTable } from "@/components/labor/employee-shifts-table"
import type { TimeEntryRow } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const entry: TimeEntryRow = {
  id: "11111111-1111-4111-8111-111111111111",
  employeeId: "22222222-2222-4222-8222-222222222222",
  employeeName: "Alex Baker",
  clockIn: new Date("2026-06-15T12:00:00Z"),
  clockOut: new Date("2026-06-15T20:00:00Z"),
  paidSeconds: 28_800,
  unpaidBreakSeconds: 0,
  breakSeconds: 0,
  timeAdjustmentSeconds: 0,
  earningsAdjustmentCents: 0,
  hourlyRateCents: 2_000,
  laborCostCents: 16_000,
  comment: "Prep",
  importId: "33333333-3333-4333-8333-333333333333",
  importTimezone: "America/New_York",
}

describe("employee shift rate editing", () => {
  it("opens from the shift row and saves a rate for only that entry", async () => {
    setTimeEntryRate.mockResolvedValue({
      ok: true,
      employeeId: entry.employeeId,
    })
    render(<EmployeeShiftsTable entries={[entry]} currencyCode="USD" />)

    fireEvent.click(screen.getByText("Jun 15, 8:00 AM"))

    expect(
      screen.getByRole("heading", { name: "Edit shift rate" })
    ).toBeDefined()
    expect(screen.getByText(/Alex Baker/).textContent).toContain("Jun 15, 2026")
    const input = screen.getByLabelText(/Hourly rate/) as HTMLInputElement
    expect(input.value).toBe("20.00")
    expect(screen.getByText(/Only this shift changes/)).toBeDefined()

    fireEvent.change(input, { target: { value: "30.00" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(setTimeEntryRate).toHaveBeenCalledWith({
        expectedCurrencyCode: "USD",
        entryId: entry.id,
        hourlyRateCents: 3_000,
      })
    )
  })
})
