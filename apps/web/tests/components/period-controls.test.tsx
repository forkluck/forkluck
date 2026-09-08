// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const { replace, pathname } = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: { current: "/labor" },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.current,
  useSearchParams: () => new URLSearchParams(),
}))

import { LaborPeriodControls } from "@/components/labor/labor-period-controls"
import { EmployeeShiftPeriodControl } from "@/components/labor/employee-shift-period-control"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/**
 * The period pills write to the page they are on. Analytics once replaced to
 * "/", a path it had moved off, and Labor spelled its own path out; both now
 * go through the browse hook, which reads the pathname.
 */
describe("the period pills", () => {
  it("write the Labor comparison to /labor and leave the default out", async () => {
    pathname.current = "/labor"
    render(
      <LaborPeriodControls
        startDate="2026-08-03"
        endDate="2026-08-09"
        comparison="fifty_two_weeks_prior"
        timeZone="UTC"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /^vs:/ }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Previous week" })
    )
    expect(replace).toHaveBeenCalledWith(
      "/labor?start=2026-08-03&end=2026-08-09&comparison=prior_week",
      { scroll: false }
    )

    replace.mockClear()
    fireEvent.click(screen.getByRole("button", { name: /^vs:/ }))
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Previous comparable period",
      })
    )
    expect(replace).toHaveBeenCalledWith(
      "/labor?start=2026-08-03&end=2026-08-09",
      { scroll: false }
    )
  })

  it("write an employee's period to that employee's own page", async () => {
    pathname.current = "/labor/emp-1"
    render(
      <EmployeeShiftPeriodControl
        startDate="2026-08-03"
        endDate="2026-08-03"
        timeZone="UTC"
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /^Date:/ }))
    // A preset wider than one day, so both keys travel.
    fireEvent.click(await screen.findByRole("button", { name: "Last 7 days" }))
    expect(replace).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/labor\/emp-1\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}$/
      ),
      { scroll: false }
    )
  })
})
