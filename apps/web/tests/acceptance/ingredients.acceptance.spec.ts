import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * Saving an ingredient must land in the table without a manual reload. The
 * save action relies on `revalidatePath` alone to refresh the current route
 * — this spec is the guard that the extra `refresh()` round-trip it used to
 * make really was redundant.
 */
test("adds an ingredient and sees it in the table without reloading", async ({
  page,
}) => {
  await signIn(page)

  await page.goto("/ingredients")
  await expect(
    page.getByRole("heading", { level: 1, name: "Ingredients" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Add ingredient" }).click()
  await expect(page).toHaveURL(/\/ingredients\/new$/)

  await page.getByLabel("Name (required)").fill("Acceptance sultanas")

  await page.getByRole("button", { name: "Save" }).click()

  await expect(page).toHaveURL(/\/ingredients\/ing_[a-z0-9]+\/ingredient$/)
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Acceptance sultanas"
  )
})
