import { expect, test, type Page } from "@playwright/test"

import { signIn } from "./sign-in"

/** The save-status pill inside the page chrome, excluding global live regions. */
const pill = (page: Page) =>
  page
    .getByRole("main")
    .locator('[data-slot="page-header"] [role="status"][aria-live="polite"]')

/**
 * A comparison is an editor like a menu: named, saved from the header,
 * kept by the account and opened again from the Compare list. The
 * synthetic workspace seeds recipes but no comparisons, so this builds one
 * from a seeded recipe and a pasted one, saves it, reopens it, edits the
 * pasted column, and leaves with the save landing on the way out.
 */
test("saves a comparison, reopens it and edits a pasted column", async ({
  page,
}, testInfo) => {
  // Unique per attempt: the acceptance database outlives a CI retry.
  const suffix = `${testInfo.testId}-${testInfo.retry}`
  const name = `Acceptance cookies ${suffix}`
  await signIn(page)

  // The list is empty of this run's comparison; a new one starts blank.
  await page.goto("/recipes/compare")
  await page.getByRole("link", { name: "New comparison" }).first().click()
  await expect(page).toHaveURL(/\/recipes\/compare\/new$/)
  await expect(
    page.getByText("Compare recipes as baker's percentages")
  ).toBeVisible()

  // One seeded recipe through the search popover.
  await page.getByRole("button", { name: /Add recipe/ }).click()
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("Sea Salt")
  await page.getByRole("button", { name: /Sea Salt Chocolate Chip/ }).click()
  await expect(page).toHaveURL(/\/recipes\/compare\/new\?r=rcp_[a-z0-9]+/)
  await expect(page.getByRole("table")).toBeVisible()

  // One pasted from elsewhere.
  await page.getByRole("button", { name: "Paste recipe" }).click()
  const paste = page.getByRole("dialog")
  await paste.getByLabel("Name").fill("Book cookies")
  await paste
    .getByLabel("Ingredients")
    .fill("300 g flour\n200 g butter\n150 g sugar\n1 egg")
  await paste.getByRole("button", { name: "Add" }).click()
  await expect(
    page.getByRole("button", { name: "Book cookies", exact: true })
  ).toBeVisible()
  await expect(pill(page)).toHaveText("Draft")

  // Named and saved from the header, it gets its own address.
  await page.getByLabel("Name (required)").fill(name)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/recipes\/compare\/cmp_[a-z0-9]+/)
  await expect(pill(page)).toHaveText("Saved")
  const address = page.url()

  // Reopened, it reads the same: both columns, the pasted one included.
  await page.reload()
  await expect(page.getByRole("heading", { name })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Book cookies", exact: true })
  ).toBeVisible()
  await expect(pill(page)).toHaveText("Saved")

  // The pasted column can be edited in place; that is a change to save.
  await page.getByRole("button", { name: "Edit Book cookies" }).click()
  const edit = page.getByRole("dialog")
  await expect(edit.getByText("Edit pasted recipe")).toBeVisible()
  await edit.getByLabel("Name").fill("Book cookies, less sugar")
  await edit
    .getByLabel("Ingredients")
    .fill("300 g flour\n200 g butter\n100 g sugar\n1 egg")
  await edit.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("button", { name: "Book cookies, less sugar", exact: true })
  ).toBeVisible()
  await expect(pill(page)).toHaveText("Draft")

  // Leaving saves on the way out, with no dialog in between.
  await page.getByRole("link", { name: "Compare" }).first().click()
  await expect(page).toHaveURL(/\/recipes\/compare$/)
  await expect(page.getByRole("link", { name })).toBeVisible()
  await expect(
    page.getByText(/Sea Salt Chocolate Chip Cookies, Book cookies, less sugar/)
  ).toBeVisible()

  // Opened from the list, the edit is there.
  await page.getByRole("link", { name }).click()
  await expect(page).toHaveURL(address.split("?")[0]!)
  await expect(
    page.getByRole("button", { name: "Book cookies, less sugar", exact: true })
  ).toBeVisible()
  await expect(pill(page)).toHaveText("Saved")
})
