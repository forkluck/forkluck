// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock("@/app/(app)/settings/actions", () => ({
  getCurrencyConversionQuote: vi.fn(),
  updateBusinessSettings: vi.fn(),
}))

import { BusinessDefaultsDialog } from "@/components/settings/business-defaults-dialog"
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/business-settings"

import {
  getCurrencyConversionQuote,
  updateBusinessSettings,
} from "@/app/(app)/settings/actions"

afterEach(cleanup)

function dialog(payrollAverageRateCents: number | null) {
  render(
    <BusinessDefaultsDialog
      initialSettings={{
        ...DEFAULT_BUSINESS_SETTINGS,
        payrollAverageRateCents,
      }}
      open
      onOpenChange={vi.fn()}
    />
  )
}

function wageField() {
  return screen.getByLabelText(
    "Average labor rate ($ / hour)"
  ) as HTMLInputElement
}

describe("the payroll average beside the labor rate", () => {
  it("fills the rate with what payroll actually pays", () => {
    dialog(1840)
    expect(wageField().value).toBe("20.00")

    fireEvent.click(screen.getByRole("button", { name: "Use" }))

    expect(screen.getByText("Payroll average: $18.40/h")).toBeTruthy()
    expect(wageField().value).toBe("18.40")
  })

  it("says nothing where there is no payroll to average", () => {
    dialog(null)

    expect(screen.queryByRole("button", { name: "Use" })).toBeNull()
    expect(screen.queryByText(/Payroll average/)).toBeNull()
  })
})

describe("the label region", () => {
  it("saves the region the kitchen labels to", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    dialog(null)

    expect(screen.getByLabelText("Label region").textContent).toContain(
      "United States"
    )

    // Base UI opens the list off the pointer sequence, not the click alone.
    const trigger = screen.getByLabelText("Label region")
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    const eu = await screen.findByRole("option", {
      name: "United Kingdom and EU",
    })
    fireEvent.pointerDown(eu)
    fireEvent.mouseDown(eu)
    fireEvent.pointerUp(eu)
    fireEvent.mouseUp(eu)
    fireEvent.click(eu)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(vi.mocked(updateBusinessSettings).mock.calls[0][0]).toMatchObject({
        labelRegion: "eu",
      })
    )
  })
})

describe("saving the business defaults", () => {
  it("closes only once the save landed", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    const onOpenChange = vi.fn()
    render(
      <BusinessDefaultsDialog
        initialSettings={DEFAULT_BUSINESS_SETTINGS}
        open
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.change(wageField(), { target: { value: "22.50" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("stays open and says why when the save did not land", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({
      error: "Backend is down",
    })
    const onOpenChange = vi.fn()
    render(
      <BusinessDefaultsDialog
        initialSettings={DEFAULT_BUSINESS_SETTINGS}
        open
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.change(wageField(), { target: { value: "22.50" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Backend is down")
    )
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("the currency conversion confirm", () => {
  it("re-asks after a cancelled confirm instead of converting", async () => {
    vi.mocked(getCurrencyConversionQuote).mockResolvedValue({
      sourceCurrency: "USD",
      targetCurrency: "EUR",
      rate: "0.9",
      rateDate: "2026-01-02",
      provider: "ECB",
    })
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    vi.mocked(updateBusinessSettings).mockClear()
    dialog(null)

    const trigger = screen.getByLabelText("Currency")
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    const euro = await screen.findByRole("option", { name: "EUR — Euro" })
    fireEvent.pointerDown(euro)
    fireEvent.mouseDown(euro)
    fireEvent.pointerUp(euro)
    fireEvent.mouseUp(euro)
    fireEvent.click(euro)

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await screen.findByText("Convert USD to EUR?")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByText("Convert USD to EUR?")).toBeNull()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await screen.findByText("Convert USD to EUR?")
    expect(updateBusinessSettings).not.toHaveBeenCalled()
  })
})

describe("the payroll tax and its estimator", () => {
  it("saves the percentage a kitchen types", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    dialog(null)

    fireEvent.change(screen.getByLabelText("Payroll tax and burden (%)"), {
      target: { value: "9.39" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      // `restoreMocks` restores spies but leaves a factory `vi.fn()`'s call
      // history in place, so the newest call is this test's, not calls[0].
      expect(
        vi.mocked(updateBusinessSettings).mock.calls.at(-1)![0]
      ).toMatchObject({
        payrollTaxPercent: 9.39,
      })
    )
  })

  it("estimates a US burden against the wage base rather than adding rates", () => {
    dialog(null)

    // New York's published figures are prefilled; the annual wage is seeded
    // from the workspace's $20/h over a full-time year. 7.65% + 0.6% capped
    // at $7,000 + 4.1% capped at $17,600, all over $40,000.
    expect(
      (screen.getByLabelText("State unemployment (%)") as HTMLInputElement)
        .value
    ).toBe("4.1")
    expect(
      (screen.getByLabelText("Charged on first ($)") as HTMLInputElement).value
    ).toBe("17600")
    expect(
      (
        screen.getByLabelText(
          "Typical annual wage per employee ($)"
        ) as HTMLInputElement
      ).value
    ).toBe("40000")

    // Not 12.35%, which is what adding the headline rates would give.
    const apply = screen.getByRole("button", { name: /^Use 9\.56%$/ })
    fireEvent.click(apply)

    expect(
      (screen.getByLabelText("Payroll tax and burden (%)") as HTMLInputElement)
        .value
    ).toBe("9.56")
  })
})

describe("the unpaid break rule", () => {
  it("is off until a kitchen turns it on, and sends zero minutes while off", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    dialog(null)

    // Off is not just a default value — the number fields are not even shown,
    // because there is no rule to configure yet.
    expect(screen.queryByLabelText("Minutes deducted")).toBeNull()
    expect(
      screen.getByText(/shifts cost exactly the hours your timesheet reports/)
    ).toBeTruthy()

    fireEvent.change(wageField(), { target: { value: "22.50" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(
        vi.mocked(updateBusinessSettings).mock.calls.at(-1)![0]
      ).toMatchObject({
        unpaidBreakMinutes: 0,
      })
    )
  })

  it("saves 30 minutes per 8 hours and explains what that does", async () => {
    vi.mocked(updateBusinessSettings).mockResolvedValue({ ok: true })
    dialog(null)

    // Base UI drives the switch off the pointer sequence, not the click.
    const toggle = screen.getByRole("switch", {
      name: "Deduct an unpaid break",
    })
    fireEvent.pointerDown(toggle)
    fireEvent.mouseDown(toggle)
    fireEvent.pointerUp(toggle)
    fireEvent.mouseUp(toggle)
    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText("Minutes deducted"), {
      target: { value: "30" },
    })
    fireEvent.change(screen.getByLabelText("Per hours worked"), {
      target: { value: "8" },
    })

    // The rule is stated in the shifts it applies to, so nobody has to guess
    // whether a short shift is docked.
    expect(
      screen.getByText(
        /a shift under 8h loses nothing, 8h to 15h loses 30 minutes, 16h loses 60/
      )
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(
        vi.mocked(updateBusinessSettings).mock.calls.at(-1)![0]
      ).toMatchObject({
        unpaidBreakMinutes: 30,
        unpaidBreakPerHours: 8,
      })
    )
  })
})
