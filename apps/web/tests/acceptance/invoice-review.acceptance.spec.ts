import { expect, test } from "@playwright/test"

import { signIn } from "./sign-in"

/**
 * The reviewer, one receipt at a time.
 *
 * Reading a receipt for real needs either a text-layer PDF or an AI key, and
 * the acceptance stack has neither — so the browser's own call to the parse
 * route is answered here, which is where that call is made. Everything after
 * it is the real thing: the dialog, the pager, and the arrow keys the merchant
 * works the pile with. Nothing is imported; that needs a read Django believes.
 */

function readReceipt(fileName: string) {
  const wegmans = fileName.startsWith("wegmans")
  return {
    fileName,
    driveFileId: null,
    driveWebViewLink: null,
    extractionModel: "text-layer",
    escalated: false,
    extraction: null,
    // One document in the file, the whole of it.
    part: { part: 0, pages: null, region: null },
    supplier: wegmans ? "wegmans" : "baldor",
    supplierName: wegmans ? "Wegmans" : "Baldor",
    documentType: "invoice",
    invoiceNumber: wegmans ? "487155" : "9001",
    invoiceDate: "2026-08-09",
    dueDate: null,
    currency: "USD",
    totalCents: 2159,
    subtotalCents: null,
    taxCents: null,
    duplicate: false,
    existingInvoice: null,
    totalsMismatch: null,
    headerWarnings: [],
    categories: [],
    lines: [
      {
        position: 1,
        sku: "1001",
        itemKey: "butter-24",
        description: "BUTTER SALTED 24#",
        quantity: 1,
        unit: "CS",
        packSize: "24 lb",
        unitPriceCents: 2159,
        lineAmountCents: 2159,
        categoryId: null,
        match: { kind: "expense-only", note: null },
        uncertain: false,
        reason: null,
        raw: {
          lineNumber: 1,
          sku: "1001",
          description: "BUTTER SALTED 24#",
          quantity: "1",
          unit: "CS",
          packSize: "24 lb",
          unitPrice: "21.59",
          lineAmount: "21.59",
          suggestedCategory: null,
          uncertain: false,
          uncertainReason: null,
        },
      },
    ],
  }
}

const pdf = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4 synthetic acceptance receipt"),
})

test("opens the reviewer on the first receipt and pages with the arrow keys", async ({
  page,
}) => {
  await page.route("**/api/invoices/parse", async (route) => {
    const request = route.request().postDataJSON() as { fileName: string }
    await route.fulfill({
      json: { documents: [readReceipt(request.fileName)] },
    })
  })

  await signIn(page)
  await page.goto("/invoices")
  await page.getByRole("button", { name: "Upload invoice" }).click()

  await page
    .locator('input[type="file"]')
    .setInputFiles([pdf("wegmans-487155.pdf"), pdf("baldor-9001.pdf")])

  // The reviewer takes the screen as soon as the first receipt is read.
  await expect(page.getByText("1 of 2")).toBeVisible()
  await expect(page.getByText("487155").first()).toBeVisible()

  await page.keyboard.press("ArrowRight")

  await expect(page.getByText("2 of 2")).toBeVisible()
  await expect(page.getByText("9001").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Files (2)" })).toBeVisible()
})

for (const width of [1280, 390]) {
  test(`receipt feedback saves corrections and stays with its receipt at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/api/invoices/parse", async (route) => {
      const request = route.request().postDataJSON() as { fileName: string }
      await route.fulfill({
        json: { documents: [readReceipt(request.fileName)] },
      })
    })
    await signIn(page)
    await page.goto("/invoices")
    await page.getByRole("button", { name: "Upload invoice" }).click()
    await page
      .locator('input[type="file"]')
      .setInputFiles([pdf("wegmans-feedback.pdf"), pdf("baldor-feedback.pdf")])
    await expect(page.getByText("1 of 2")).toBeVisible()
    await page
      .getByRole("spinbutton", { name: "Quantity for BUTTER SALTED 24#" })
      .fill("4")
    await page.getByRole("button", { name: "Report a receipt problem" }).click()
    await page
      .getByLabel("What went wrong? (optional)")
      .fill("The quantity was wrong; corrected it to four.")
    await page.screenshot({ path: testInfo.outputPath("feedback-form.png") })
    await page.getByRole("button", { name: "Send feedback" }).click()
    await expect(page.getByText("Feedback sent")).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Report a receipt problem" })
    ).toHaveAttribute("aria-pressed", "true")
    await page
      .getByRole("button", { name: "Next receipt", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Report a receipt problem" })
    ).toHaveAttribute("aria-pressed", "false")
    await page
      .getByRole("button", { name: "Previous receipt", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Report a receipt problem" })
    ).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "Report a receipt problem" }).click()
    await expect(page.getByLabel("What went wrong? (optional)")).toHaveValue(
      "The quantity was wrong; corrected it to four."
    )
    await page.getByRole("button", { name: "Looks right" }).click()
    await page.getByRole("button", { name: "Update feedback" }).click()
    await expect(
      page.getByRole("button", { name: "Receipt read correctly" })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      page.getByRole("button", { name: "Import", exact: true })
    ).toBeVisible()
  })
}
