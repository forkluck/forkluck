import { expect, test } from "@playwright/test"

for (const endpoint of ["csrf", "login"]) {
  test(`sign in recovers when the ${endpoint} request loses its connection`, async ({
    page,
  }) => {
    await page.goto("/login")
    await page.getByLabel("Email").fill("playwright@example.test")
    await page
      .getByLabel("Password", { exact: true })
      .fill("Synthetic acceptance 2026!")
    const path = `**/api/auth/${endpoint}`
    await page.route(path, (route) => route.abort("connectionreset"), {
      times: 1,
    })
    const submit = page.getByRole("button", { name: "Sign in", exact: true })
    await submit.click()
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Couldn't connect to Forkluck" })
    ).toBeVisible()
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page).toHaveURL(/\/$/)
  })
}
