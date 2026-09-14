import { expect, test } from "@playwright/test"

test("public Forkluck runs without Primo even when invoice AI has a key", async ({
  page,
}) => {
  await page.goto("/login")
  await page.getByLabel("Email").fill("playwright@example.test")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic acceptance 2026!")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/analytics$/)
  await expect(
    page.getByRole("heading", { name: "Analytics", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Message Primo" })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Open Primo", exact: true })
  ).toHaveCount(0)
  await page.getByRole("link", { name: "Recipes", exact: true }).click()
  await expect(page).toHaveURL(/\/recipes$/)
  await expect(
    page.getByRole("button", { name: "Open Primo", exact: true })
  ).toHaveCount(0)
  const response = await page.request.post("/api/primo/chat", {
    headers: { Origin: new URL(page.url()).origin },
    data: {},
  })
  expect(response.status()).toBe(503)
})
