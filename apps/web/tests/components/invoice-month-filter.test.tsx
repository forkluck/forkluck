// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const push = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => {
  const router = { push }
  return { useRouter: () => router }
})

import { InvoiceMonthFilter } from "@/components/invoices/month-filter"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Newest first, exactly as the overview serializer orders them.
const MONTHS = [
  { month: "2026-08" },
  { month: "2026-05" },
  { month: "2025-11" },
]

function open(month = "2026-05") {
  render(<InvoiceMonthFilter month={month} months={MONTHS} />)
  fireEvent.click(
    screen.getByRole("button", { name: `Month: ${label(month)}` })
  )
}

function label(month: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`))
}

describe("the Invoices month pill", () => {
  it("opens on the selected month's year", async () => {
    open()

    expect(await screen.findByText("2026")).toBeTruthy()
    expect(
      (
        screen.getByRole("button", { name: "May 2026" }) as HTMLButtonElement
      ).getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("disables the months with no invoices", async () => {
    open()

    // April 2026 has no invoices; May and August do.
    expect(
      (
        (await screen.findByRole("button", {
          name: "April 2026",
        })) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      (screen.getByRole("button", { name: "August 2026" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("navigates to the month it is given", async () => {
    open()

    fireEvent.click(await screen.findByRole("button", { name: "August 2026" }))

    // August is the newest month, which is what the bare path already renders.
    expect(push).toHaveBeenCalledWith("/invoices")
  })

  it("pins an older month in the URL", async () => {
    open("2026-08")

    fireEvent.click(
      await screen.findByRole("button", { name: "Previous year" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "November 2025" })
    )

    expect(push).toHaveBeenCalledWith("/invoices?month=2025-11")
  })

  it("goes back to the newest month from the footer row", async () => {
    open()

    fireEvent.click(
      await screen.findByRole("button", { name: "Most recent month" })
    )

    expect(push).toHaveBeenCalledWith("/invoices")
  })

  it("stops the year arrows at the months that exist", async () => {
    open("2025-11")

    expect(
      (
        (await screen.findByRole("button", {
          name: "Previous year",
        })) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      (screen.getByRole("button", { name: "Next year" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})
