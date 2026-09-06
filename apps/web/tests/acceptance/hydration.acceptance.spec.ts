import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

// The browser runs in Pacific/Kiritimati (playwright.config.ts); a formatter
// that resolves its own zone renders a different day than the server HTML.
const SCREENS = [
  "/recipes",
  "/ingredients",
  "/supplies",
  "/supplies/new",
  "/menu",
  "/products",
  "/products/new",
  "/integrations/sales/mapping",
  "/integrations/sales/mapping/ignored",
  "/invoices",
  "/labor",
  "/integrations/sales/connections",
  "/integrations/sales/activity",
  "/integrations/suppliers/connections",
  "/integrations/suppliers/mapping",
  "/integrations/suppliers/activity",
  "/settings",
]

test("no screen mismatches between the server HTML and hydration", async ({
  page,
}) => {
  const mismatches: string[] = []
  const record = (text: string, at: string) => {
    if (/hydrat|#418|server[- ]rendered/i.test(text)) {
      mismatches.push(`${at}: ${text.slice(0, 400)}`)
    }
  }
  page.on("console", (message) => record(message.text(), page.url()))
  page.on("pageerror", (error) => record(String(error.message), page.url()))

  await signIn(page)
  for (const screen of SCREENS) {
    await page.goto(screen)
    await page.waitForLoadState("networkidle")
  }

  expect(mismatches).toEqual([])
})
