import { expect, type Page } from "@playwright/test"

const seededAccount = {
  email: "playwright@example.test",
  password: "Synthetic acceptance 2026!",
}

/** The seeded member holding an editor share on the owner's recipes. */
export const sharedEditorAccount = {
  email: "playwright-editor@example.test",
  password: "Synthetic acceptance 2026!",
}

/** Signs an account into the seeded synthetic workspace and lands on the overview. */
export async function signIn(page: Page, account = seededAccount) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(account.email)
  await page.getByLabel("Password", { exact: true }).fill(account.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/$/)
}
