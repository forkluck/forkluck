import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

test("Save stays busy until the refreshed account screen commits", async ({
  page,
}) => {
  await signIn(page)
  await page.goto("/settings")
  await page.getByRole("button", { name: /Account details/ }).click()
  const dialog = page.getByRole("dialog", { name: "Account details" })
  const name = dialog.getByLabel("Name", { exact: true })
  const original = await name.inputValue()
  await name.fill(`${original} refreshed`)

  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let refreshing = false
  await page.route("**/settings*", async (route) => {
    const request = route.request()
    if (request.method() === "GET" && request.headers().rsc === "1") {
      refreshing = true
      await held
    }
    await route.continue()
  })
  try {
    await dialog.getByRole("button", { name: "Save", exact: true }).click()
    await expect.poll(() => refreshing).toBe(true)
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeDisabled()
  } finally {
    release()
  }
  await expect(dialog).not.toBeVisible()
  await page.unroute("**/settings*")

  // This is the shared synthetic acceptance account; leave its name intact.
  await page.getByRole("button", { name: /Account details/ }).click()
  await name.fill(original)
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(dialog).not.toBeVisible()
})
