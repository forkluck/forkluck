import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * Supplies are ingredients with the not-food flag, so the two lists are one
 * table over one endpoint. This spec is the guard that they stay disjoint:
 * a supply created here must never surface in the pantry.
 */
test("adds a supply and keeps it out of the pantry", async ({ page }) => {
  await signIn(page)

  await page.goto("/supplies")
  await expect(
    page.getByRole("heading", { level: 1, name: "Supplies" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Add supply" }).click()
  await expect(page).toHaveURL(/\/supplies\/new$/)

  await page.getByLabel("Name (required)").fill("Acceptance takeout box")
  // The Cost fields are on the create screen too; the form's save carries the
  // pack along with the name.
  await page.getByLabel(/^Cost \(/).fill("12.00")
  await page.getByLabel("Size", { exact: true }).fill("10 lb")
  await page.getByLabel("Size", { exact: true }).blur()
  await page.getByRole("button", { name: "Save" }).click()

  await expect(page).toHaveURL(/\/ingredients\/ing_[a-z0-9]+\/ingredient$/)
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Acceptance takeout box"
  )
  await expect(page.getByRole("link", { name: "Nutrition" })).toHaveCount(0)
  // The ingredient screen, minus everything only food has.
  await expect(page).toHaveTitle("Supply — Forkluck")
  // One page: the cost sits on it rather than behind a tab strip.
  for (const tab of ["Ingredient", "Supply", "Cost"]) {
    await expect(
      page.getByRole("link", { name: tab, exact: true })
    ).toHaveCount(0)
  }
  await expect(
    page.getByRole("heading", { name: "Cost", exact: true })
  ).toBeVisible()
  await expect(page.getByLabel(/^Cost \(/)).toHaveValue("12.00")
  await expect(page.getByLabel("Size", { exact: true })).toHaveValue("10")
  await expect(page.getByRole("heading", { name: "Preparations" })).toHaveCount(
    0
  )
  await expect(page.getByRole("heading", { name: "UOM" })).toHaveCount(0)
  // A recipe can never hold a supply, so Used in asks about products instead.
  await expect(page.getByText("No product uses this yet.")).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Up" }).getByRole("link")
  ).toHaveText("Supplies")

  await page.goto("/supplies")
  // Scoped to the table: the detail page's title still holds the name while
  // the list streams in, and a fast runner lands the check inside that gap.
  await expect(
    page.getByRole("table").getByText("Acceptance takeout box")
  ).toBeVisible()

  await page.goto("/ingredients")
  await expect(page.getByText("Acceptance takeout box")).toHaveCount(0)
})
