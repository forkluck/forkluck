import { expect, test } from "@playwright/test"
import { signIn } from "./sign-in"

test("fresh windows share saved Recents but keep selection and unfinished drafts independent", async ({
  page,
  context,
}) => {
  await signIn(page)
  const composer = page.getByRole("textbox", { name: "Message Primo" })
  const accepted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/primo/chat") && request.method() === "POST"
  )
  await composer.fill("Calculate batch fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  const { conversationId } = (await accepted).postDataJSON()
  const calculation = page.getByText(
    "The exact selling price is $2.875; the minimum price is $2.88.",
    { exact: true }
  )
  await expect(calculation).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop Primo" })).toHaveCount(0)
  const title = (
    await page.getByRole("button", { name: /^Recent chats/ }).innerText()
  ).trim()
  expect(title).not.toBe("Primo")
  await composer.fill("Only window A")

  const other = await context.newPage()
  await other.goto("/")
  const otherComposer = other.getByRole("textbox", { name: "Message Primo" })
  await expect(otherComposer).toHaveValue("")
  await expect(
    other.getByRole("heading", { name: "How can I help in the kitchen?" })
  ).toBeVisible()
  await expect(
    other.getByText(
      "The exact selling price is $2.875; the minimum price is $2.88.",
      { exact: true }
    )
  ).toHaveCount(0)
  await expect(
    other.getByRole("region", { name: "Recent conversations" })
  ).toHaveCount(0)
  await other.getByRole("button", { name: /^Recent chats/ }).click()
  await other
    .getByRole("dialog", { name: "Recent chats" })
    .getByRole("button", { name: title, exact: true })
    // The synthetic gateway names every fixture identically; the new chat is first.
    .first()
    .click()
  await expect(
    other.getByText(
      "The exact selling price is $2.875; the minimum price is $2.88.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(other).toHaveURL(`/?c=${conversationId}`)
  await expect(otherComposer).toHaveValue("")
  await otherComposer.fill("Only window B")
  await other.reload()
  await expect(otherComposer).toHaveValue("Only window B")
  await page.reload()
  await expect(composer).toHaveValue("Only window A")
  await expect(calculation).toBeVisible()

  await other.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(otherComposer).toHaveValue("")
  await expect(calculation).toBeVisible()
  await expect(composer).toHaveValue("Only window A")
  await other.reload()
  await expect(
    other.getByRole("heading", { name: "How can I help in the kitchen?" })
  ).toBeVisible()

  // An explicit history link is an intentional reopen in a fresh window.
  const linked = await context.newPage()
  await linked.goto(`/?c=${conversationId}`)
  await expect(
    linked.getByText(
      "The exact selling price is $2.875; the minimum price is $2.88.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    linked.getByRole("textbox", { name: "Message Primo" })
  ).toHaveValue("")
  await linked.close()
  await other.close()
})

test("the rail expands into Home with its named conversation and composer intact", async ({
  page,
}) => {
  await signIn(page)
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Calculate batch fixture")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText(
      "The exact selling price is $2.875; the minimum price is $2.88.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop Primo" })).toHaveCount(0)
  const title = await page
    .getByRole("button", { name: /^Recent chats/ })
    .innerText()
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Draft follows the surface")
  await page.getByRole("link", { name: "Ingredients", exact: true }).click()
  await page.getByRole("button", { name: "Open Primo", exact: true }).click()
  const rail = page.getByRole("complementary", { name: "Primo" })
  await expect(rail.getByRole("button", { name: /^Recent chats/ })).toHaveText(
    title
  )
  await expect(
    rail.getByRole("textbox", { name: "Message Primo" })
  ).toHaveValue("Draft follows the surface")
  await rail.getByRole("button", { name: "Expand Primo" }).click()
  await expect(page).toHaveURL("/")
  await expect(
    page.getByRole("textbox", { name: "Message Primo" })
  ).toHaveValue("Draft follows the surface")
  await expect(
    page.getByText(
      "The exact selling price is $2.875; the minimum price is $2.88.",
      { exact: true }
    )
  ).toBeVisible()
})
