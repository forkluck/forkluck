import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * The ingredient Nutrition tab builds a label preview from the seeded custom
 * snapshot alone, with no USDA key in the acceptance environment, and a chip
 * toggle saves without a Save button. The recipe side is pinned by the
 * component suite and the Django rollup tests; this guards the wiring.
 */
test("previews an ingredient's label and toggles an allergen tag", async ({
  page,
}) => {
  await signIn(page)

  await page.goto("/ingredients")
  await page.getByRole("row", { name: /Unsalted Butter/ }).click()
  await expect(page).toHaveURL(/\/ingredients\/ing_[a-z0-9]+\/ingredient$/)
  await page.getByRole("link", { name: "Nutrition" }).click()
  await expect(page).toHaveURL(/\/nutrition$/)

  await expect(page.getByText("Custom nutrition value")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Nutrition Facts" })
  ).toBeVisible()
  await expect(page.getByText("Contains: Milk")).toBeVisible()

  // Toggling a tag saves on its own; the header says so.
  await page.getByRole("button", { name: "Sesame" }).first().click()
  await expect(
    page
      .getByRole("main")
      .locator('[data-slot="page-header"] [role="status"][aria-live="polite"]')
  ).toHaveText("Saved")
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sesame", pressed: true }).first()
  ).toBeVisible()
})
