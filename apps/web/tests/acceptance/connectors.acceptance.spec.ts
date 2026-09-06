import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * This crosses all of the real seams: Forkluck's connector catalog, the
 * standalone HTTP fake's hosted authorization redirect, the public callback
 * bridge, the authenticated server action, and the durable worker. The fake
 * deliberately rejects the first page acknowledgement; one invoice row after
 * the worker retries proves the replay did not duplicate the import.
 */
test("connects a supplier through the hosted flow and imports its replayed page", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/integrations/suppliers/connections")

  // Rows are scoped: the Drive folder above offers a Connect of its own.
  // Scoped to main as well: the streamed page arrives in a hidden segment
  // before React swaps it in, and a fast runner lands the check while both
  // copies of the row are in the DOM.
  const acme = page
    .getByRole("main")
    .locator('[data-slot="integration-row"]')
    .filter({ hasText: "Acme Produce" })
  await expect(acme).toBeVisible()
  await expect(
    acme.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()

  // `Connect` is a normal top-level navigation to the standalone fake. It
  // redirects through /api/integrations/connectors/callback and returns to
  // this page with a one-time code, which the browser hands to the server
  // action before the URL is replaced.
  await acme.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page).toHaveURL(/\/integrations\/suppliers\/connections/)
  await expect(page.getByText("Supplier connected")).toBeVisible()
  await expect(page).toHaveURL(/\/integrations\/suppliers\/connections$/)
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible()

  await page.getByRole("button", { name: "Sync now" }).click()
  await expect(page.getByText("Acme Produce sync started")).toBeVisible()

  // The worker is a separate process in the acceptance stack. Reload while
  // its first acknowledgement fails and its second pass receives the same
  // page; the single result row is the effectively-once assertion.
  const importedRow = page
    .getByRole("row")
    .filter({ hasText: "Acme Produce" })
    .filter({ hasText: "ACME-100" })
  await expect(async () => {
    await page.goto("/invoices")
    await expect(importedRow).toHaveCount(1, { timeout: 1_000 })
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1_000] })

  await expect(importedRow).toBeVisible()
  await expect(
    page.getByRole("table").getByText("Supplier import", { exact: true })
  ).toBeVisible()
})
