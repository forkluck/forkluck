import { expect, test, type Page } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * Products is a catalog table, not a report: eight columns, a Status pill, and
 * server-side sort in the URL. The synthetic workspace seeds no products, so
 * this suite builds the two rows it reasons about through the same screens a
 * merchant uses, and runs serially because every later step reads them back.
 */
test.describe.configure({ mode: "serial" })

const CHEAP = "Acceptance amaranth loaf"
const DEAR = "Acceptance zaatar tin"
const BOX = "Acceptance sampler box"
/**
 * "Last 30 days" ends yesterday, and the workspace timezone need not match this
 * machine's, so manual sales are recorded a few days back to land in the window.
 */
const RECENT_DAY = new Date(Date.now() - 3 * 86_400_000)
  .toISOString()
  .slice(0, 10)
/** A second day, so the two views differ by a whole row and not just a count. */
const BOX_DAY = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)

const DEFAULT_COLUMNS = [
  "Product",
  "Category",
  "Channels",
  "Variants",
  "SKU",
  "Price",
  "Status",
]

/** Adds a product from the create page and returns to a settled table. */
async function addProduct(page: Page, name: string) {
  await page.goto("/products?status=all")
  // A serial retry replays the whole file, so a second creation would leave
  // two rows under one name and every later lookup ambiguous. The list streams
  // in behind a spinner, and count() does not wait, so settle the page first.
  await page.waitForLoadState("networkidle")
  if ((await page.getByRole("link", { name }).count()) > 0) return
  // Creating is a page of its own, reached the way recipes and ingredients are.
  await page.getByRole("link", { name: "Add product" }).click()
  await expect(page).toHaveURL(/\/products\/new$/)
  await page.locator("#product-name").fill(name)
  await page.getByRole("button", { name: "Save" }).click()
  // Saving hands the merchant the new product's page, so the table the callers
  // read is a navigation away.
  await expect(page).toHaveURL(/\/products\/prd_[a-z0-9]+$/)
  await page.goto("/products?status=all")
  await expect(page.getByRole("link", { name })).toBeVisible()
}

/** Fills in the catalog fields the list column reads, then saves. */
/** The rail's category picker: type the name and add it. */
async function chooseCategory(page: Page, category: string) {
  await page.getByRole("button", { name: "Category" }).click()
  await page
    .getByRole("searchbox", { name: "Search categories" })
    .fill(category)
  await page.getByRole("button", { name: `Add “${category}”` }).click()
}

async function editProduct(
  page: Page,
  name: string,
  {
    price,
    category,
    active,
    sku,
  }: { price: string; category: string; active: boolean; sku: string }
) {
  await page.goto("/products?status=all")
  await page.getByRole("link", { name }).click()
  await expect(page).toHaveURL(/\/products\/prd_[a-z0-9]+$/)

  await page.locator("#product-price").fill(price)
  // A product may carry no SKU row yet, so add one before filling it.
  const firstSku = page.getByRole("textbox", { name: "SKU", exact: true })
  if ((await firstSku.count()) === 0)
    await page.getByRole("button", { name: "+ Add SKU" }).click()
  await firstSku.fill(sku)
  await chooseCategory(page, category)
  await page.getByRole("combobox", { name: "Status" }).click()
  await page
    .getByRole("option", { name: active ? "Active" : "Inactive", exact: true })
    .click()

  await page.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ })
  ).toBeVisible()
}

function row(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name })
}

test("builds the two catalog rows the rest of the suite reads", async ({
  page,
}) => {
  await signIn(page)

  await addProduct(page, CHEAP)
  await editProduct(page, CHEAP, {
    price: "5.00",
    category: "Bakery",
    active: true,
    sku: "ACC-LOAF",
  })

  await addProduct(page, DEAR)
  await editProduct(page, DEAR, {
    price: "90.00",
    category: "Pantry",
    active: false,
    sku: "ACC-TIN",
  })
})

test("keeps a pack SKU and its units after a reload", async ({ page }) => {
  await signIn(page)
  await page.goto("/products?status=all")
  await page.getByRole("link", { name: CHEAP }).click()
  await expect(page).toHaveURL(/\/products\/prd_[a-z0-9]+$/)

  const pack = page.getByRole("textbox", { name: "SKU 2" })
  const packUnits = page.getByRole("button", { name: "Units per sale" }).nth(1)
  // A serial retry replays the file, and the pack may already be there.
  if ((await pack.count()) === 0) {
    await page.getByRole("button", { name: "+ Add SKU" }).click()
    await pack.fill("ACC-LOAF-6")
    await packUnits.click()
    await page.getByRole("spinbutton", { name: "Units per sale" }).fill("6")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Save" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved$/ })
    ).toBeVisible()
  }

  await page.reload()
  await expect(pack).toHaveValue("ACC-LOAF-6")
  await expect(packUnits).toHaveText("6 ea")
})

test("shows the catalog columns and none of the old sales ones", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/products")

  const headers = page.getByRole("table").getByRole("columnheader")
  for (const name of DEFAULT_COLUMNS) {
    await expect(headers.filter({ hasText: name })).toHaveCount(1)
  }
  for (const gone of ["Units", "Sales", "Updated"]) {
    await expect(headers.filter({ hasText: gone })).toHaveCount(0)
  }
  // The date window went with the sales figures.
  await expect(page.getByRole("button", { name: /^Date:/ })).toHaveCount(0)
})

test("opens on active products and widens to all through the Status pill", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/products")

  await expect(row(page, CHEAP)).toBeVisible()
  await expect(row(page, DEAR)).toHaveCount(0)

  await page.getByRole("button", { name: "Status: Active" }).click()
  await page.getByRole("menuitem", { name: "All", exact: true }).click()

  await expect(page).toHaveURL(/[?&]status=all/)
  await expect(row(page, CHEAP)).toBeVisible()
  await expect(row(page, DEAR)).toBeVisible()
})

test("sorts by price in both directions through the URL", async ({ page }) => {
  await signIn(page)
  await page.goto("/products?status=all")

  const priceHeader = page
    .getByRole("table")
    .getByRole("button", { name: "Price" })
  const firstRow = page.getByRole("table").getByRole("row").nth(1)

  await priceHeader.click()
  await expect(page).toHaveURL(/[?&]order=price(&|$)/)
  await expect(firstRow).toContainText(CHEAP)

  await priceHeader.click()
  await expect(page).toHaveURL(/[?&]order=-price(&|$)/)
  await expect(firstRow).toContainText(DEAR)
})

// No page-2 assertion: the synthetic workspace holds far fewer than the 50
// products a first page carries, so a second page never exists here.
test("reveals the hidden Updated column", async ({ page }) => {
  await signIn(page)
  await page.goto("/products")

  const headers = page.getByRole("table").getByRole("columnheader")
  await page
    .getByRole("table")
    .getByRole("button", { name: /^Columns/ })
    .click()
  await page.getByRole("menuitem", { name: "Updated", exact: true }).click()
  await page.keyboard.press("Escape")

  await expect(headers.filter({ hasText: "SKU" })).toHaveCount(1)
  await expect(headers.filter({ hasText: "Updated" })).toHaveCount(1)
})

test("opens a product from its name link and edits it from the row", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/products")

  await page.getByRole("link", { name: CHEAP }).click()
  await expect(page).toHaveURL(/\/products\/prd_[a-z0-9]+$/)
  const productUrl = page.url()

  await page.goto("/products")
  await row(page, CHEAP)
    .getByRole("button", { name: `Actions for ${CHEAP}` })
    .click()
  await page.getByRole("menuitem", { name: "Edit product" }).click()
  await expect(page).toHaveURL(productUrl)
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await chooseCategory(page, "Breads")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ })
  ).toBeVisible()

  await page.getByRole("button", { name: "+ Record sale" }).click()
  await page.locator("#manual-sale-date").fill(RECENT_DAY)
  await page.locator("#manual-sale-quantity").fill("3")
  await page.getByRole("button", { name: "Record sale" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await page.goto("/products")
  await expect(row(page, CHEAP)).toContainText("Breads")
})

test("deletes two products from the selection bar", async ({ page }) => {
  await signIn(page)

  const doomed = ["Acceptance doomed one", "Acceptance doomed two"]
  for (const name of doomed) await addProduct(page, name)

  await page.goto("/products")
  for (const name of doomed) {
    await row(page, name).getByRole("checkbox", { name: "Select row" }).click()
  }

  await page.getByRole("button", { name: "Selection actions" }).click()
  await page.getByRole("menuitem", { name: "Delete products" }).click()
  await page.getByRole("button", { name: "Delete products" }).click()

  for (const name of doomed) {
    await expect(row(page, name)).toHaveCount(0)
  }
})

test("keeps the table, product column pinned, at a phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.goto("/products")

  await expect(page.getByRole("table")).toBeVisible()
  await expect(row(page, CHEAP)).toBeVisible()
  await expect(
    page.getByRole("button", { name: `Actions for ${CHEAP}` })
  ).toBeVisible()
})

test("ignores the parameters the old sales table used to read", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/products?start=2026-01-01&end=2026-02-01&colour=red")

  await expect(page.getByText("A server error occurred")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { level: 1, name: "Products" })
  ).toBeVisible()
  await expect(row(page, CHEAP)).toBeVisible()
})

test("shows both sales figures and switches the daily table", async ({
  page,
}) => {
  await signIn(page)

  // The box sells one CHEAP, so CHEAP's including-bundles figures run ahead of
  // the three units it recorded as sold on RECENT_DAY.
  await addProduct(page, BOX)
  await page.getByRole("link", { name: BOX }).click()
  await page.getByRole("button", { name: "+ Add component" }).click()
  const picker = page.getByRole("dialog", { name: "Add components" })
  await picker.getByRole("button", { name: "Products", exact: true }).click()
  await picker.getByLabel("Search products").fill(CHEAP)
  await picker.getByRole("checkbox", { name: CHEAP }).click()
  await picker.getByRole("button", { name: "Add", exact: true }).click()
  await page.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ })
  ).toBeVisible()

  await page.getByRole("button", { name: "+ Record sale" }).click()
  await page.locator("#manual-sale-date").fill(BOX_DAY)
  await page.locator("#manual-sale-quantity").fill("2")
  await page.getByRole("button", { name: "Record sale" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // The summary left the page with the rail; the daily table is the reading
  // of record, and its row count moves with the view.
  await page.goto("/products")
  await page.getByRole("link", { name: CHEAP }).click()

  const daily = page.locator("table").filter({ hasText: "Date" })
  await expect(daily.getByRole("row")).toHaveCount(3)

  await page.getByRole("button", { name: /^View:/ }).click()
  await page.getByRole("menuitem", { name: "As sold" }).click()
  await expect(daily.getByRole("row")).toHaveCount(2)
})
