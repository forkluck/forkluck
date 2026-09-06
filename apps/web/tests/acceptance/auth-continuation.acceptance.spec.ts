import { expect, test } from "@playwright/test"

// An auth API document exercises the same full navigation required by the
// feedback OAuth endpoint, without contacting any external feedback service.
const next = "/api/auth/session"
const continuation = `?next=${encodeURIComponent(next)}`

test("sign-in preserves the feedback continuation across signup", async ({
  page,
}) => {
  await page.goto(`/login${continuation}`)
  await page.getByRole("link", { name: "Sign up", exact: true }).click()
  await expect(page).toHaveURL(`/signup${continuation}`)
  await page.getByRole("link", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(`/login${continuation}`)
  await page.getByLabel("Email").fill("playwright@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic acceptance 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(next)
  await expect(page.locator("body")).toContainText("playwright@example.test")
})

test("a new account resumes the feedback continuation", async ({ page }) => {
  await page.goto(`/signup${continuation}`)
  await page.getByLabel("Name").fill("Feedback acceptance")
  await page.getByLabel("Email").fill("feedback-acceptance@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic acceptance 2026!")
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(page).toHaveURL(next)
  await expect(page.locator("body")).toContainText(
    "feedback-acceptance@example.test"
  )
})
