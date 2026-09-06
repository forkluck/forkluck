import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_BUSINESS_SETTINGS,
  type BusinessSettings,
} from "@/lib/business-settings"

/**
 * What `updateBusinessSettings` actually puts on the wire.
 *
 * `businessSettingsSchema` is a plain `z.object`, so Zod *strips* a key the
 * schema does not declare rather than rejecting it. The action's input type is
 * `Omit<BusinessSettings, "productMatching">`, which keeps typecheck green
 * whether or not the schema still lists a field — so a field dropped from the
 * schema silently stops being sent, `update-business-settings` falls back to
 * the stored value (`domains/workspace/actions.py`), and the dialog closes as
 * though the merchant's edit was saved.
 *
 * The guard is therefore the whole payload rather than one field: every
 * business default the dialog collects has to survive parsing, and a field
 * added to `BusinessSettings` later joins the assertion on its own. The backend
 * tests post to Django directly and never exercise this seam.
 */

const sent: { slug: string; body: Record<string, unknown> }[] = []

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({}),
}))
vi.mock("@/lib/backend/queries", () => ({
  getInvoiceSuppliers: () => Promise.resolve([]),
}))
vi.mock("@/lib/backend/client", () => ({
  djangoAction: (slug: string, body: Record<string, unknown>) => {
    sent.push({ slug, body })
    return Promise.resolve({})
  },
}))

const { updateBusinessSettings } = await import("@/app/(app)/settings/actions")

/** The defaults the dialog writes: every one except those it never sends. */
const COLLECTED_KEYS = (
  Object.keys(DEFAULT_BUSINESS_SETTINGS) as (keyof BusinessSettings)[]
).filter(
  (key) => key !== "productMatching" && key !== "payrollAverageRateCents"
)

const INPUT = {
  wagePerHourCents: 2500,
  measurementSystem: "us",
  currencyCode: "USD",
  labelRegion: "us",
  timezone: "America/New_York",
  foodCostTarget: 0.32,
  overtimeWeeklyMinutes: 2250,
  payrollTaxPercent: 9.39,
  unpaidBreakMinutes: 30,
  unpaidBreakPerHours: 8,
  expectedCurrencyCode: "USD",
} satisfies Omit<
  BusinessSettings,
  "productMatching" | "payrollAverageRateCents"
> & {
  expectedCurrencyCode: BusinessSettings["currencyCode"]
}

describe("updateBusinessSettings", () => {
  beforeEach(() => {
    sent.length = 0
  })

  it("sends every business default the dialog collects", async () => {
    await updateBusinessSettings(INPUT)

    expect(sent).toHaveLength(1)
    expect(sent[0].slug).toBe("update-business-settings")
    // Names the dropped field on failure rather than reporting a bare mismatch.
    expect(Object.keys(sent[0].body).sort()).toEqual(
      expect.arrayContaining([...COLLECTED_KEYS].sort())
    )
  })

  it("carries the edited values rather than dropping them", async () => {
    await updateBusinessSettings(INPUT)

    // A stripped key reads as "unchanged" to Django, not as an error, so the
    // values have to be asserted and not only the key set.
    expect(sent[0].body).toMatchObject({
      wagePerHourCents: 2500,
      measurementSystem: "us",
      foodCostTarget: 0.32,
      overtimeWeeklyMinutes: 2250,
      timezone: "America/New_York",
      payrollTaxPercent: 9.39,
      unpaidBreakMinutes: 30,
      unpaidBreakPerHours: 8,
    })
  })
})
