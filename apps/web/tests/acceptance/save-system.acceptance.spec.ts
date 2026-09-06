import { expect, test, type Page } from "@playwright/test"

import { sharedEditorAccount, signIn } from "./sign-in"

/** The save system end to end: failure, conflict, save-on-leave, confirm, restore, dialog. */

const RECIPE = "Sea Salt Chocolate Chip Cookies"
const INGREDIENT = "Unsalted Butter"

/** The save-status pill inside the page chrome, excluding global live regions. */
const pill = (page: Page) =>
  page
    .getByRole("main")
    .locator('[data-slot="page-header"] [role="status"][aria-live="polite"]')

/** Aborts the screen's server actions; the controller sees the same request failure a stopped backend gives. */
async function breakSaves(page: Page, pattern: string) {
  await page.route(pattern, (route) => {
    const request = route.request()
    if (request.method() === "POST" && request.headers()["next-action"]) {
      return route.abort("failed")
    }
    return route.continue()
  })
}

async function openRecipe(page: Page) {
  await page.goto("/recipes")
  await page.getByRole("link", { name: RECIPE }).click()
  await expect(page).toHaveURL(/\/recipes\/rcp_[a-z0-9]+\/recipe$/)
  await expect(pill(page)).toHaveText("Saved")
}

async function openIngredient(page: Page) {
  await page.goto("/ingredients")
  await page.getByRole("row", { name: new RegExp(INGREDIENT) }).click()
  await expect(page).toHaveURL(/\/ingredients\/ing_[a-z0-9]+\/ingredient$/)
}

test("a recipe reads Not saved while the backend refuses, and Saved once it answers", async ({
  page,
}) => {
  await signIn(page)
  await openRecipe(page)

  await breakSaves(page, "**/recipes/**")
  await page.getByLabel("Description").fill("Written while the backend is down")
  await expect(pill(page)).toHaveText("Not saved", { timeout: 15_000 })

  await page.unroute("**/recipes/**")
  await page.getByLabel("Description").fill("Written once the backend is back")
  await expect(pill(page)).toHaveText("Saved", { timeout: 15_000 })
})

test("an editor sharing the recipe reads Changed elsewhere and keeps its draft", async ({
  browser,
}, testInfo) => {
  const first = await browser.newPage()
  const second = await browser.newPage()
  await signIn(first)
  await signIn(second, sharedEditorAccount)
  await openRecipe(first)
  await openRecipe(second)

  // The Saved pill is in the page shell, which can arrive before the editor.
  // Both editors must hold the original version before the owner changes it.
  await expect(first.getByLabel("Description")).toBeVisible()
  await expect(second.getByLabel("Description")).toBeVisible()
  // The database survives CI retries; each attempt must actually change a value.
  const ownerText = `Saved by the owner ${testInfo.repeatEachIndex}-${testInfo.retry}`
  const editorText = `Typed by the editor ${testInfo.repeatEachIndex}-${testInfo.retry}`

  await first.getByLabel("Description").fill(ownerText)
  await expect(pill(first)).toHaveText("Saved", { timeout: 15_000 })

  await second.getByLabel("Description").fill(editorText)
  await expect(pill(second)).toHaveText("Changed elsewhere", {
    timeout: 15_000,
  })

  // A dirty screen prompts before a reload; the draft it kept outlives it.
  second.on("dialog", (dialog) => void dialog.accept())
  await second.reload()
  await expect(
    second.getByText("This device kept changes that never reached the server.")
  ).toBeVisible()
  await second.getByRole("button", { name: "Restore" }).click()
  await expect(second.getByRole("main").getByLabel("Description")).toHaveValue(
    editorText
  )

  await first.close()
  await second.close()
})

test("a dirty menu saves itself on the way to another screen", async ({
  page,
}, testInfo) => {
  // Unique per attempt: the acceptance database outlives a CI retry.
  const renamed = `Acceptance lunch ${testInfo.testId}-${testInfo.retry}`
  await signIn(page)
  await page.goto("/menu/new")
  await page
    .getByRole("main")
    .getByLabel("Name (required)")
    .fill("Acceptance dinner service")
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/menu\/mnu_[a-z0-9]+/)
  await expect(pill(page)).toHaveText("Saved", { timeout: 15_000 })

  await page.getByRole("main").getByLabel("Name (required)").fill(renamed)
  await page.getByRole("link", { name: "Recipes", exact: true }).click()
  await expect(page).toHaveURL(/\/recipes$/)
  await expect(page.getByText("Leave without saving?")).toHaveCount(0)

  await page.goto("/menu")
  await expect(page.getByRole("row", { name: renamed })).toBeVisible()
})

test("a dirty ingredient asks before the other tab", async ({ page }) => {
  await signIn(page)
  await openIngredient(page)

  await page.getByLabel("Name (required)").fill("Unsalted Butter, renamed")
  await page.getByRole("link", { name: "Nutrition" }).click()

  await expect(page.getByText("Leave without saving?")).toBeVisible()
  await page.getByRole("button", { name: "Stay" }).click()
  await expect(page).toHaveURL(/\/ingredient$/)
  await expect(page.getByLabel("Name (required)")).toHaveValue(
    "Unsalted Butter, renamed"
  )
})

test("a reload mid-edit offers the draft back", async ({ page }) => {
  await signIn(page)
  await openRecipe(page)

  // The save is held down so the draft cannot be cleared by one landing
  // between the edit and the reload.
  await breakSaves(page, "**/recipes/**")
  await page.getByLabel("Description").fill("Recovered after a reload")
  await expect(pill(page)).toHaveText("Not saved", { timeout: 15_000 })

  page.on("dialog", (dialog) => void dialog.accept())
  await page.reload()
  await expect(
    page.getByText("This device kept changes that never reached the server.")
  ).toBeVisible()
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByRole("main").getByLabel("Description")).toHaveValue(
    "Recovered after a reload"
  )
})

test("the preparation dialog stays open when its write fails", async ({
  page,
}) => {
  await signIn(page)
  await openIngredient(page)

  await page
    .getByRole("button", { name: "Actions", exact: true })
    .first()
    .click()
  await page.getByRole("menuitem", { name: "Add preparation" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name (required)").fill("Clarified")

  await breakSaves(page, "**/ingredients/**")
  await dialog.getByRole("button", { name: "Add preparation" }).click()

  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByLabel("Name (required)")).toHaveValue("Clarified")
})
