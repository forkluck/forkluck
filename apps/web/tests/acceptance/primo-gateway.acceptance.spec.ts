import { expect, test } from "@playwright/test"
import { signIn } from "./sign-in"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQokWP4TyJgGNVABGAgRhEyGNVADKB9KAEAr639H8LdEzEAAAAASUVORK5CYII=",
  "base64"
)

test("the public app reads a photo and confirms a draft through the synthetic gateway", async ({
  page,
}) => {
  await signIn(page)
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "Synthetic recipe.png",
    mimeType: "image/png",
    buffer: png,
  })
  await expect(
    page.getByText("Read from image; check uncertain details.")
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Draft a synthetic gateway soup from the photo")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText(
      "The recipe draft is ready to review. Nothing has been saved."
    )
  ).toBeVisible()
  const create = page.getByRole("button", {
    name: "Create recipe",
    exact: true,
  })
  await expect(create).toBeVisible()
  await create.click()
  await expect(page.getByText("Recipe created", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Open recipe", exact: true })
  ).toHaveAttribute("href", /\/recipes\/rcp_[a-z0-9]+\/recipe/)
})

test("a gateway outage keeps Home, history, retry and the next draft usable", async ({
  page,
}) => {
  await signIn(page)
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Gateway outage fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByText("Response interrupted. Try again.")).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page
      .getByRole("region", { name: "Primo conversation" })
      .getByText("Gateway outage fixture", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Retry response", exact: true })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Keep this next draft")
  await page.getByRole("link", { name: "Open Analytics", exact: true }).click()
  await expect(page).toHaveURL(/\/analytics$/)
  await page.getByRole("button", { name: "Open Primo", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Message Primo" })
  ).toHaveValue("Keep this next draft")
})
