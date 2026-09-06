// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const { setEmployeeActive, setEmployeeExcludedFromCost, toastAdd } = vi.hoisted(
  () => ({
    setEmployeeActive: vi.fn(),
    setEmployeeExcludedFromCost: vi.fn(),
    toastAdd: vi.fn(),
  })
)

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/labor",
}))
vi.mock("@/app/(app)/labor/actions", () => ({
  setEmployeeActive,
  setEmployeeExcludedFromCost,
}))
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))
vi.mock("@/components/labor/add-employee-dialog", () => ({
  AddEmployeeDialog: () => null,
}))
vi.mock("@/components/labor/employee-rate-dialog", () => ({
  EmployeeRateDialog: () => null,
}))
vi.mock("@/components/labor/import-labor-dialog", () => ({
  ImportHoursDialog: () => null,
}))
vi.mock("@/components/labor/labor-import-history-dialog", () => ({
  LaborImportHistoryDialog: () => null,
}))
vi.mock("@/components/labor/labor-period-controls", () => ({
  LaborPeriodControls: () => null,
}))

import { LaborWorkspace } from "@/components/labor/labor-workspace"
import type { EmployeeRow } from "@/lib/backend/types"

const alex: EmployeeRow = {
  id: "employee-1",
  name: "Alex Baker",
  normalizedName: "alex baker",
  isActive: true,
  excludedFromCost: false,
  currentHourlyRateCents: 2000,
  currentRateEffectiveFrom: null,
  shiftCount: 2,
  totalSeconds: 28_800,
  unpaidBreakSeconds: 0,
  laborCostCents: 16_000,
  payrollTaxCents: 0,
  uncostedCount: 0,
  firstShiftAt: null,
  lastShiftAt: null,
  rateHistory: [],
}

function renderWorkspace() {
  render(
    <LaborWorkspace
      employees={[alex]}
      imports={[]}
      overtime={{ weeklyThresholdMinutes: 2400, byEmployee: {} }}
      currencyCode="USD"
      startDate="2026-06-01"
      endDate="2026-06-07"
      comparison="prior_week"
      timeZone="America/New_York"
      today="2026-06-07"
    />
  )
}

function archive() {
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Alex Baker" })
  )
  fireEvent.click(screen.getByText("Archive"))
}

function leaveOutOfCost() {
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Alex Baker" })
  )
  fireEvent.click(screen.getByText("Leave out of cost"))
}

beforeEach(() => {
  setEmployeeActive.mockResolvedValue({ ok: true })
  setEmployeeExcludedFromCost.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("archiving an employee", () => {
  it("takes the row out of Active as soon as it is asked for", async () => {
    renderWorkspace()
    archive()

    await waitFor(() => expect(screen.queryByText("Alex Baker")).toBeNull())
    expect(setEmployeeActive).toHaveBeenCalledWith({
      employeeId: "employee-1",
      isActive: false,
    })
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("puts the row back and says so when the server refuses", async () => {
    setEmployeeActive.mockResolvedValue({ error: "Nope." })
    renderWorkspace()
    archive()

    await waitFor(() => expect(screen.getByText("Alex Baker")).not.toBeNull())
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t archive Alex Baker",
      description: "Nope.",
      type: "error",
    })
  })
})

describe("leaving an employee out of cost", () => {
  it("marks the row and drops its cost as soon as it is asked for", async () => {
    renderWorkspace()
    expect(screen.getByText("$160.00")).not.toBeNull()
    expect(screen.getByText("8.0")).not.toBeNull()

    leaveOutOfCost()

    await waitFor(() => expect(screen.getByText("Not costed")).not.toBeNull())
    // The hours they worked are still theirs; only the money goes.
    expect(screen.getByText("8.0")).not.toBeNull()
    expect(screen.queryByText("$160.00")).toBeNull()
    expect(setEmployeeExcludedFromCost).toHaveBeenCalledWith({
      employeeId: "employee-1",
      excludedFromCost: true,
    })
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("puts the cost back and says so when the server refuses", async () => {
    setEmployeeExcludedFromCost.mockResolvedValue({ error: "Nope." })
    renderWorkspace()
    leaveOutOfCost()

    await waitFor(() => expect(screen.getByText("$160.00")).not.toBeNull())
    expect(screen.queryByText("Not costed")).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith({
      title: "Couldn’t leave Alex Baker out of cost",
      description: "Nope.",
      type: "error",
    })
  })
})
