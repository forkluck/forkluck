import { expect, test, type Locator, type Page } from "@playwright/test"
import { signIn } from "./sign-in"
import { kitchenPdf, invoiceLines } from "../fixtures/primo-documents"

async function drop(
  page: Page,
  target: Locator,
  name: string,
  text = "Recipe: bread\nFlour 200 g\nWater 120 g"
) {
  const transfer = await page.evaluateHandle(
    ({ name, text }) => {
      const data = new DataTransfer()
      data.items.add(new File([text], name, { type: "text/plain" }))
      return data
    },
    { name, text }
  )
  await target.dispatchEvent("dragenter", { dataTransfer: transfer })
  await expect(page.getByText("Drop recipes or invoices here")).toBeVisible()
  if (name === "greeting.txt")
    await page.screenshot({
      path: "output/playwright/primo-drop-overlay.png",
      fullPage: true,
    })
  await target.dispatchEvent("dragover", { dataTransfer: transfer })
  await target.dispatchEvent("drop", { dataTransfer: transfer })
  await transfer.dispose()
  await expect(page.getByText("Uploading…", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Reading file…", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible()
}
function response(text: string) {
  return (
    [
      { type: "start", messageId: "synthetic-response" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: text },
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: "stop" },
    ]
      .map((part) => `data: ${JSON.stringify(part)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  )
}

test("Home accepts files over the greeting, margins, composer and transcript", async ({
  page,
}) => {
  await signIn(page)
  await expect(
    page.getByRole("heading", { name: "How can I help in the kitchen?" })
  ).toBeVisible()
  await drop(
    page,
    page.getByRole("heading", { name: "How can I help in the kitchen?" }),
    "greeting.txt"
  )
  await drop(page, page.locator("[data-primo-drop-target]"), "margin.txt")
  await drop(
    page,
    page.getByRole("textbox", { name: "Message Primo" }),
    "composer.txt"
  )
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Read these recipes")
  await page.route("**/api/primo/chat", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body: response("The uploaded recipes say flour 200 g and water 120 g."),
    })
  )
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByRole("region", { name: "Primo conversation" })
  ).toHaveCount(1)
  await expect(
    page.getByText("The uploaded recipes say flour 200 g and water 120 g.")
  ).toBeVisible()
  await drop(
    page,
    page.getByText("Read these recipes", { exact: true }),
    "transcript.txt"
  )
  await expect(page).toHaveURL(/\/$/)
  await page.screenshot({
    path: "output/playwright/primo-home-attachments.png",
    fullPage: true,
  })
})

test("an invoice upload survives Home-to-rail navigation, reload and preview", async ({
  page,
}) => {
  await signIn(page)
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "Synthetic invoice.pdf",
    mimeType: "application/pdf",
    buffer: kitchenPdf([invoiceLines]),
  })
  await expect(page.getByText("Read 1 of 1 pages.")).toBeVisible()
  await page.getByRole("link", { name: "Recipes", exact: true }).click()
  await page.getByRole("button", { name: "Open Primo", exact: true }).click()
  const rail = page.getByRole("complementary", { name: "Primo" })
  await expect(
    rail.getByRole("button", { name: "Synthetic invoice.pdf", exact: true })
  ).toBeVisible()
  await drop(page, rail.getByText("Primo", { exact: true }), "rail.txt")
  await page.screenshot({
    path: "output/playwright/primo-rail-attachments.png",
    fullPage: true,
  })
  await page.getByRole("link", { name: "Home", exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(
    page.getByRole("heading", { name: "How can I help in the kitchen?" })
  ).toBeVisible()
  await page.reload()
  await page
    .getByRole("button", { name: "Synthetic invoice.pdf", exact: true })
    .click()
  const preview = page.getByRole("dialog", { name: "Synthetic invoice.pdf" })
  await expect(
    preview.getByText(/Flour[\s\S]*2 bags[\s\S]*20.00/)
  ).toBeVisible()
  await expect(
    preview.getByRole("link", { name: "Download original" })
  ).toBeVisible()
  await page.screenshot({
    path: "output/playwright/primo-invoice-preview.png",
    fullPage: true,
  })
})

test("files can be prepared during an answer and invalid drops are explained", async ({
  page,
}) => {
  await signIn(page)
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/primo/chat", async (route) => {
    await waiting
    await route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body: response("Ready to help with your recipe."),
    })
  })
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Help with a recipe")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("button", { name: "Stop Primo" })).toBeVisible()
  await drop(page, page.locator("[data-primo-drop-target]"), "next-recipe.txt")
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(
    0
  )
  finish()
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled()
  await page.getByLabel("Attach files", { exact: true }).setInputFiles([
    {
      name: "unsupported.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("not a document"),
    },
    {
      name: "accepted-recipe.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Flour 200 g"),
    },
  ])
  await expect(
    page.locator("[data-primo-drop-target]").getByRole("alert")
  ).toContainText("unsupported.exe")
  await expect(
    page.getByRole("button", { name: "accepted-recipe.txt", exact: true })
  ).toBeVisible()
})

test("mobile Home and Primo dialog share picker and paste uploads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "mobile-recipe.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Flour 200 g"),
  })
  await expect(page.getByText("Read document text.")).toBeVisible()
  await page.goto("/recipes")
  await page.getByRole("button", { name: "Open Primo", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Primo", exact: true })
  await expect(
    dialog.getByRole("button", { name: "mobile-recipe.txt", exact: true })
  ).toBeVisible()
  await expect(
    dialog.getByRole("textbox", { name: "Message Primo" })
  ).toBeEnabled()
  const pasted = await dialog
    .getByRole("textbox", { name: "Message Primo" })
    .evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(
        new File(["Invoice flour 2 bags 20.00"], "pasted-invoice.txt", {
          type: "text/plain",
        })
      )
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        })
      )
      return data.files.length
    })
  expect(pasted).toBe(1)
  await expect(
    dialog.getByRole("button", { name: "pasted-invoice.txt", exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: "output/playwright/primo-mobile-attachments.png",
    fullPage: true,
  })
  const bounds = await dialog.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390)
})
