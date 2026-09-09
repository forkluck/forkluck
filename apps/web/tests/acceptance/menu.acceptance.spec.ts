import { expect, test, type Page } from "@playwright/test"

import { signIn } from "./sign-in"

/** The save-status pill inside the page chrome, excluding global live regions. */
const pill = (page: Page) =>
  page
    .getByRole("main")
    .locator('[data-slot="page-header"] [role="status"][aria-live="polite"]')

/**
 * A few days back, so the sale lands inside any window a screen defaults to
 * whatever timezone the workspace reports in.
 */
const SOLD_DAY = new Date(Date.now() - 3 * 86_400_000)
  .toISOString()
  .slice(0, 10)

/**
 * The forecast screen renders on the server and links every forecast row to
 * its Product. A link helper that lives in a `"use client"` module throws when
 * the server calls it, and neither tsc nor a jsdom render sees that — only
 * opening the real page against the real stack does. The synthetic workspace
 * seeds no menus and no products, so this builds both through the screens a
 * merchant uses: a product row imported from sales, and a recipe row created
 * through the worksheet's picker.
 */
test("forecasts a saved menu and links each row to its product", async ({
  page,
}, testInfo) => {
  // Unique per attempt: the acceptance database outlives a CI retry.
  const suffix = `${testInfo.testId}-${testInfo.retry}`
  const product = `Acceptance forecast scone ${suffix}`
  const recipe = `Acceptance forecast soup ${suffix}`

  await signIn(page)

  await page.goto("/products/new")
  await page.getByRole("main").locator("#product-name").fill(product)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/products\/prd_[a-z0-9]+$/)

  // Priced between the two rows the Products suite sorts on, so the shared
  // acceptance workspace keeps answering that test the same way.
  await page.locator("#product-price").fill("12.00")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved", { exact: true })).toBeVisible()

  // A product row reads its Qty sold from what the product sold over the
  // menu's period, so the sale has to exist before the import.
  await page.getByRole("button", { name: "+ Record sale" }).click()
  await page.locator("#manual-sale-date").fill(SOLD_DAY)
  await page.locator("#manual-sale-quantity").fill("4")
  await page.getByRole("button", { name: "Record sale" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await page.goto("/menu/new")
  await page
    .getByRole("main")
    .getByLabel("Name (required)")
    .fill(`Acceptance service ${suffix}`)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/menu\/mnu_[a-z0-9]+/)
  await expect(pill(page)).toHaveText("Saved", { timeout: 15_000 })

  await page.getByRole("button", { name: "Import from products" }).click()
  await page.getByLabel("Search products").fill(product)
  await page.getByRole("checkbox", { name: product }).check()
  await page.getByRole("button", { name: "Import 1" }).click()

  // The product row's units come from sales and are not typed.
  await expect(page.getByRole("textbox", { name: "Qty sold" })).toHaveCount(0)
  const productRow = page.getByRole("row").filter({ hasText: product })
  await expect(productRow).toContainText("4")

  // A hand-typed row resolves through the picker; nothing matches this name,
  // so the picker creates the recipe and links it.
  await page.getByRole("button", { name: "+ Add" }).click()
  await page.getByRole("combobox", { name: "Item name" }).fill(recipe)
  await page.getByRole("button", { name: `Add recipe “${recipe}”` }).click()
  await expect(page.getByRole("link", { name: recipe })).toBeVisible()
  const qty = page.getByRole("textbox", { name: "Qty sold" })
  await qty.fill("2")
  await qty.blur()

  await page.getByRole("button", { name: "Save" }).click()
  await expect(pill(page)).toHaveText("Saved", { timeout: 15_000 })

  await page.getByRole("link", { name: "Forecast", exact: true }).click()
  await expect(page).toHaveURL(/\/menu\/mnu_[a-z0-9]+\/forecast$/)
  await expect(
    page.getByRole("heading", { level: 2, name: "Expected demand" })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: product })).toHaveAttribute(
    "href",
    /^\/products\/prd_[a-z0-9]+$/
  )
  await expect(
    page.getByRole("heading", { name: "Production forecast", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: `Why this quantity for ${product}` })
    .click()
  const explanation = page.getByRole("region", {
    name: `Why this quantity for ${product}`,
  })
  await expect(
    explanation.getByText("Recent demand suggests", { exact: true })
  ).toBeVisible()
  await explanation.getByRole("button", { name: "View sales history" }).click()
  await expect(
    explanation.getByRole("table", { name: "Recent sales", exact: true })
  ).toBeVisible()
  await expect(
    explanation.getByRole("table", {
      name: "Same period last year",
      exact: true,
    })
  ).toBeVisible()
  await page
    .getByRole("button", { name: `Why this quantity for ${product}` })
    .click()
  await expect(page.getByTestId("forecast-money-caption")).toHaveCount(1)
  await page.getByRole("link", { name: "Day", exact: true }).click()
  await expect(page).toHaveURL(/\/forecast\?view=day$/)
  const demand = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Expected demand", exact: true }),
  })
  await expect(demand.getByRole("columnheader")).toHaveCount(10)
  await page.getByRole("link", { name: "Busy", exact: true }).click()
  await expect(page).toHaveURL(/\/forecast\?plan=busy&view=day$/)
  await page.getByRole("link", { name: "Next 30 days", exact: true }).click()
  await expect(page).toHaveURL(/\/forecast\?days=30&plan=busy&view=day$/)
  await expect(demand.getByRole("columnheader")).toHaveCount(8)
  await page.reload()
  await expect(
    page.getByRole("link", { name: "Day", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await page.getByRole("link", { name: "Week", exact: true }).click()
  await expect(page).toHaveURL(/\/forecast\?days=30&plan=busy$/)
  await expect(demand.getByRole("columnheader")).toHaveCount(4)
})
