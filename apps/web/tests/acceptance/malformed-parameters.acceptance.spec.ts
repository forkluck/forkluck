import { expect, test, type Page } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * Every URL here carries a parameter that passes a shape check but that the
 * Django read model refuses, or that its URL table cannot match at all. Each
 * one used to answer with the "a server error occurred" screen, because the
 * refusal reached the Server Component as an unhandled exception. Each must now
 * answer with the fallback the screen already renders for a value it recognizes
 * as unusable.
 *
 * The rows are run at a desktop and a mobile viewport: the regression is in
 * server-rendered code, so the fallback has to hold at both.
 */

const KNOWN_ABSENT_ID = "00000000-0000-0000-0000-000000000000"

/** A screen that renders. `name` is a heading that proves which one. */
const renders = [
  // Overview: a month or day outside the calendar, and a window longer than
  // the year both reports allow.
  { path: "/?tab=activity&start=2026-13-45", name: "Analytics" },
  { path: "/?tab=activity&start=2026-01-32", name: "Analytics" },
  { path: "/?tab=activity&start=0000-01-01", name: "Analytics" },
  { path: "/?tab=activity&start=2020-01-01&end=2026-01-01", name: "Analytics" },
  { path: "/?tab=activity&start=2026-01-01&end=2026-12-31", name: "Analytics" },
  {
    path: "/?tab=activity&start=2026-07-01&start=2026-07-02",
    name: "Analytics",
  },
  // Labor reads the same parameters through the same guards.
  { path: "/labor?start=2026-13-45", name: "Labor" },
  { path: "/labor?start=0000-01-01", name: "Labor" },
  { path: "/labor?start=2020-01-01&end=2026-01-01", name: "Labor" },
  // Invoices: a well-formed month that is not a month.
  { path: "/invoices?month=2026-13", name: "Invoices" },
  { path: "/invoices?month=2026-00", name: "Invoices" },
  { path: "/invoices?month=9999-99", name: "Invoices" },
  { path: "/invoices?month=0000-01", name: "Invoices" },
  { path: "/invoices?month=2026-12", name: "Invoices" },
  // Products no longer reads a date window; a bookmarked one, and anything
  // else left in the URL, must be ignored rather than refused.
  {
    path: "/products?start=2026-01-01&end=2026-02-01&colour=red",
    name: "Products",
  },
]

/**
 * Employee ids the internal route table cannot match. Each must land on the
 * same "not found" screen as `KNOWN_ABSENT_ID`, which the table can match and
 * simply does not find — that equivalence is the invariant, so the control is
 * asserted alongside them rather than a status code being pinned here.
 */
const unroutableEmployees = [
  "/labor/not-a-uuid",
  "/labor/123",
  "/labor/3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  `/labor/${KNOWN_ABSENT_ID}?start=2026-13-45`,
  `/labor/${KNOWN_ABSENT_ID}?start=2020-01-01&end=2026-01-01`,
]

/**
 * The failure this suite exists for. Next.js streams the shell before the
 * Server Component throws, so the response is still 200 and only the body says
 * the screen died — asserting on the status alone would not have caught it.
 */
async function expectNoServerError(page: Page) {
  await expect(page.getByText("A server error occurred")).toHaveCount(0)
}

const viewports = [
  { label: "desktop", viewport: { width: 1280, height: 800 } },
  { label: "mobile", viewport: { width: 390, height: 844 } },
]

for (const { label, viewport } of viewports) {
  test.describe(`malformed parameters (${label})`, () => {
    test.use({ viewport })

    test("fall back instead of taking the screen down", async ({ page }) => {
      await signIn(page)
      for (const { path, name } of renders) {
        await test.step(path, async () => {
          await page.goto(path)
          await expectNoServerError(page)
          await expect(
            page.getByRole("heading", { level: 1, name })
          ).toBeVisible()
        })
      }
    })

    test("read an unroutable id as a missing row", async ({ page }) => {
      await signIn(page)
      const control = `/labor/${KNOWN_ABSENT_ID}`
      for (const path of [control, ...unroutableEmployees]) {
        await test.step(path, async () => {
          await page.goto(path)
          await expectNoServerError(page)
          await expect(page.getByText("This page doesn’t exist")).toBeVisible()
        })
      }
    })
  })
}
