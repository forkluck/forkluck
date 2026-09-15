import { expect, test } from "@playwright/test"
import { signIn } from "./sign-in"

test("reopened drafts preserve their method and notes across real server tool revisions", async ({
  page,
}) => {
  await signIn(page)
  const composer = page.getByRole("textbox", { name: "Message Primo" })
  const send = async (text: string) => {
    await composer.fill(text)
    await page.getByRole("button", { name: "Send message" }).click()
    await expect(page.getByRole("button", { name: "Stop Primo" })).toHaveCount(
      0,
      { timeout: 20_000 }
    )
  }
  await send("Draft revision fixture")
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toBeVisible()
  await send("Halve revision fixture")
  await expect(
    page.getByText(
      "Scaled yield and measured ingredients by 0.5×. Method preserved exactly."
    )
  ).toBeVisible()
  const newest = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Synthetic butter cookies" }),
    })
    .last()
  await expect(newest).toContainText("12 pieces")
  await expect(newest).toContainText("150 g")
  await expect(newest).toContainText("Bake at 175 C for 12 minutes.")
  await expect(newest).toContainText(
    "Source: Synthetic.txt. Check the oven temperature."
  )
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toHaveCount(2)
  await send("Salt revision fixture")
  await expect(
    page.getByText("Updated ingredient 4: Salt. Method preserved exactly.")
  ).toBeVisible()
  await expect(newest).toContainText("1 1/2 g")
  await expect(newest).toContainText("150 g")
  await expect(newest).toContainText("check amount")
  await expect(newest).toContainText("Bake at 175 C for 12 minutes.")
  await expect(
    page.getByRole("button", { name: "Create recipe", exact: true })
  ).toHaveCount(3)
})

test("batch calculations and Home starters return inspectable cards and report links", async ({
  page,
}) => {
  await signIn(page)
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Calculate batch fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByRole("heading", { name: "Hypothetical batch costs · USD" })
  ).toBeVisible()
  await expect(page.getByText("$2.875", { exact: true })).toBeVisible()
  await expect(page.getByText("$2.88", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await page
    .getByRole("button", {
      name: "Which three products had the most net sales last month?",
    })
    .click()
  await expect(
    page.getByRole("heading", { name: /Top products/ })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "View sales report" })
  ).toHaveAttribute("href", "/analytics?start=2026-08-01&end=2026-08-31")
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await page
    .getByRole("button", { name: "What changed in ingredient costs?" })
    .click()
  await expect(
    page.getByRole("heading", { name: /Ingredient price changes/ })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Open ingredients" })
  ).toBeVisible()
})

test("editing an earlier question replaces the saved tail and preserves an unsent composer draft", async ({
  page,
}) => {
  await signIn(page)
  const composer = page.getByRole("textbox", { name: "Message Primo" })
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "Synthetic notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic recipe notes: preserve the method."),
  })
  await composer.fill("Draft revision fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toBeVisible()
  await composer.fill("Halve revision fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText(/Scaled yield and measured ingredients/)
  ).toBeVisible()
  await composer.fill("My unsent follow-up")
  await page
    .getByRole("button", { name: "Edit question", exact: true })
    .first()
    .click()
  await page
    .getByRole("textbox", { name: "Edit question" })
    .fill("Calculate batch fixture")
  await page.getByRole("button", { name: "Save and resend" }).click()
  await expect(
    page.getByRole("heading", { name: "Hypothetical batch costs · USD" })
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Edit question" })
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toHaveCount(0)
  await expect(composer).toHaveValue("My unsent follow-up")
  await expect(
    page.getByText("Synthetic notes.txt", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Hypothetical batch costs · USD" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Synthetic butter cookies" })
  ).toHaveCount(0)
  await expect(
    page.getByText("Halve revision fixture", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Edit question", exact: true })
  ).toHaveCount(1)
})
