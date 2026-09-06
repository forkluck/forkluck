import { expect, test } from "@playwright/test"

/**
 * The guest page is the one screen a reader with no account can open, so it is
 * exercised with no session at all: Playwright hands each test a fresh context,
 * and neither test signs in.
 *
 * The reading half needs a share token in the acceptance database. The demo
 * seed does not mint one yet, so that test runs only when the harness passes a
 * token in; the refusal half needs nothing seeded and always runs.
 */
const seededToken = process.env.FORKLUCK_ACCEPTANCE_GUEST_TOKEN ?? ""

test("refuses a token nothing was ever shared under", async ({ page }) => {
  const response = await page.goto("/shared/not-a-real-share-token")

  expect(response?.status()).toBe(404)
  await expect(page.getByText("A server error occurred")).toHaveCount(0)
})

test("reads a shared recipe without signing in, at any batch", async ({
  page,
}) => {
  test.skip(
    !seededToken,
    "FORKLUCK_ACCEPTANCE_GUEST_TOKEN is not seeded yet: the share token comes from the backend seam."
  )

  await page.goto(`/shared/${seededToken}`)

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(page.getByText(/^Shared by /)).toBeVisible()
  // Cookies stay empty: nothing on this page may depend on a session.
  expect(await page.context().cookies()).toEqual([])

  const quantity = page
    .getByRole("table")
    .getByRole("row")
    .nth(1)
    .getByRole("cell")
    .first()
  const written = (await quantity.innerText()).trim()
  expect(written).not.toBe("")

  await page.getByLabel("Batch size").click()
  await page.getByText("2x", { exact: true }).click()

  await expect(page.getByLabel("Batch size")).toHaveText("2x")
  await expect(quantity).not.toHaveText(written)
})
