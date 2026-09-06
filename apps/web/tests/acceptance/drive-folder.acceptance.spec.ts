import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * The Drive row on Suppliers → Connections.
 *
 * The acceptance stack configures the service-account *address* but no key,
 * which is exactly the state this spec can assert end to end: the share
 * instructions render, and a link that is not a folder link is refused in the
 * server action before any Google call. Connecting for real needs a live
 * Drive, and its fetch happens on the Next server, where a browser route
 * interception cannot reach it.
 */
test("offers the Drive folder and refuses a link that isn't a folder", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/integrations/suppliers/connections")

  // Scoped to main: the streamed page arrives in a hidden segment before
  // React swaps it in, and a fast runner lands the check while both copies
  // of the row are in the DOM.
  const row = page
    .getByRole("main")
    .locator('[data-slot="integration-row"]:visible')
    .filter({ hasText: "Google Drive" })
  await expect(row).toBeVisible()
  await expect(row.getByText("Not connected")).toBeVisible()
  await row.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(
    page.getByText("acceptance-drive@example.test", { exact: false })
  ).toBeVisible()
  await expect(page.getByText("Viewer is enough.")).toBeVisible()

  await page
    .getByLabel("Google Drive folder link")
    .fill("kitchen-receipts, the folder on my desktop")
  await page.getByRole("button", { name: "Connect folder" }).click()
  await expect(
    page.getByText("That doesn't look like a Google Drive folder link.")
  ).toBeVisible()
})
