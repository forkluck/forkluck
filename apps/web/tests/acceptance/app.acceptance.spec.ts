import { expect, test, type Page } from "@playwright/test"

import { signIn } from "./sign-in"

test("redirects a guest from a protected screen to sign in", async ({
  page,
}) => {
  await page.goto("/recipes")

  await expect(page).toHaveURL(/\/login$/)
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome back" })
  ).toBeVisible()
})

test("signs into the seeded synthetic workspace and reads its recipes", async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole("link", { name: "Analytics", exact: true }).click()

  await expect(
    page.getByRole("heading", { level: 1, name: "Analytics" })
  ).toBeVisible()

  await page.getByRole("link", { name: "Recipes", exact: true }).click()
  await expect(page).toHaveURL(/\/recipes$/)
  await expect(
    page.getByRole("heading", { level: 1, name: "Recipes" })
  ).toBeVisible()
  await expect(
    page.getByRole("row", { name: /Sea Salt Chocolate Chip Cookies/ })
  ).toBeVisible()
})

/** The shell owns the scrollbar: the document itself must never scroll. */
function measureScroll(page: Page) {
  // Next can retain the previous route in a hidden Activity tree.
  return page.getByRole("main").evaluate((main) => {
    const pane = main.parentElement
    return {
      paneClientHeight: pane?.clientHeight ?? 0,
      paneScrollHeight: pane?.scrollHeight ?? 0,
      rootClientHeight: document.documentElement.clientHeight,
      rootScrollHeight: document.documentElement.scrollHeight,
    }
  })
}

test("keeps long recipe scrolling inside the app shell", async ({ page }) => {
  await signIn(page)

  await page.goto("/recipes")
  await page
    .getByRole("link", { name: "Sea Salt Chocolate Chip Cookies" })
    .click()
  await expect(page).toHaveURL(/\/recipes\/rcp_[a-z0-9]+\/recipe$/)
  await expect(
    page.getByRole("heading", { level: 2, name: "Additional details" })
  ).toBeVisible()

  const scroll = await measureScroll(page)

  expect(scroll.paneScrollHeight).toBeGreaterThan(scroll.paneClientHeight)
  expect(scroll.rootScrollHeight).toBe(scroll.rootClientHeight)
})

test("keeps an ingredient screen scrolling inside the app shell", async ({
  page,
}) => {
  await signIn(page)

  await page.goto("/ingredients")
  await page.getByRole("row", { name: /Unsalted Butter/ }).click()
  await expect(page).toHaveURL(/\/ingredients\/ing_[a-z0-9]+\/ingredient$/)
  await expect(
    page.getByRole("heading", { level: 2, name: "Tags" })
  ).toBeVisible()

  const scroll = await measureScroll(page)

  expect(scroll.rootScrollHeight).toBe(scroll.rootClientHeight)
})

test("creates a new account only inside the temporary acceptance database", async ({
  page,
}) => {
  await page.goto("/signup")
  await page.getByLabel("Name").fill("Synthetic Acceptance Chef")
  await page.getByLabel("Email").fill("new-chef@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Another synthetic 2026!")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto("/analytics")
  await expect(
    page.getByRole("heading", { level: 1, name: "Analytics" })
  ).toBeVisible()
})
