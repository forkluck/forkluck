// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

const { loadActivity } = vi.hoisted(() => ({ loadActivity: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/app/(app)/settings/actions", () => ({ loadActivity }))
vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ timezone: "UTC", currencyCode: "USD" }),
}))

import { InvoiceActivity } from "@/components/invoices/invoice-activity"
import type { ActivityEvent } from "@/lib/backend/types"

afterEach(() => {
  cleanup()
  loadActivity.mockReset()
})

const INVOICE_ID = "11111111-1111-4111-8111-111111111111"

function event(partial: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "act-1",
    actorName: "Ada Lovelace",
    resourceType: "invoice",
    resourceId: INVOICE_ID,
    event: "edited",
    name: "Local Farm · A-1",
    context: {},
    createdAt: new Date("2026-08-12T15:04:00Z"),
    ...partial,
  }
}

describe("an invoice's own activity", () => {
  it("asks for this invoice's entries alone", async () => {
    loadActivity.mockResolvedValue({ items: [event()], nextBefore: null })
    render(<InvoiceActivity resourceId={INVOICE_ID} />)

    expect(await screen.findByText(/Invoice edited/)).toBeTruthy()
    expect(loadActivity).toHaveBeenCalledWith({ resourceId: INVOICE_ID })
  })

  it("names a supplier connector's own import", async () => {
    loadActivity.mockResolvedValue({
      items: [
        event({
          id: "act-2",
          event: "added",
          context: { fileName: "", source: "connector" },
        }),
      ],
      nextBefore: null,
    })
    render(<InvoiceActivity resourceId={INVOICE_ID} />)

    expect(await screen.findByText(/Added by supplier import/)).toBeTruthy()
  })

  it("names the file a document was read from", async () => {
    loadActivity.mockResolvedValue({
      items: [
        event({
          id: "act-3",
          event: "added",
          context: { fileName: "scan.jpg", source: "" },
        }),
      ],
      nextBefore: null,
    })
    render(<InvoiceActivity resourceId={INVOICE_ID} />)

    expect(await screen.findByText(/Added from scan\.jpg/)).toBeTruthy()
  })

  it("groups a run of the same edit into one row", async () => {
    loadActivity.mockResolvedValue({
      items: [event(), event({ id: "act-4" }), event({ id: "act-5" })],
      nextBefore: null,
    })
    render(<InvoiceActivity resourceId={INVOICE_ID} />)

    expect(await screen.findByText(/3 times/)).toBeTruthy()
  })

  it("says so when nothing is logged yet", async () => {
    loadActivity.mockResolvedValue({ items: [], nextBefore: null })
    render(<InvoiceActivity resourceId={INVOICE_ID} />)

    expect(await screen.findByText("Nothing yet.")).toBeTruthy()
  })
})
