import { expect, test } from "@playwright/test"
import { signIn, sharedEditorAccount } from "./sign-in"

const id = "00000000-0000-4000-8000-000000000099"
const date = "2026-09-05T19:00:00.000Z"
const conversation = {
  id,
  title: "Synthetic recipe recovery",
  isArchived: false,
  archivedAt: null,
  lastMessageAt: date,
  createdAt: date,
  updatedAt: date,
}
const message = {
  id: "interrupted-draft",
  role: "assistant",
  status: "complete",
  metadata: {},
  createdAt: date,
  parts: [
    {
      type: "tool-draft_recipe",
      toolCallId: "draft",
      state: "input-streaming",
      input: { title: "Synthetic soup" },
    },
  ],
}

for (const width of [1280, 390]) {
  test(`Recent retries and explicitly reopens an interrupted draft in a fresh window at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 850 })
    await signIn(page)
    let failList = true
    await context.route("**/api/primo/conversations?**", async (route) => {
      expect(route.request().method()).toBe("GET")
      expect(route.request().headers()["next-action"]).toBeUndefined()
      const detail = new URL(route.request().url()).searchParams.has("id")
      await route.fulfill({
        status: !detail && failList ? 502 : 200,
        json: detail
          ? { item: { conversation, messages: [message] } }
          : failList
            ? { error: "Couldn’t load recent chats." }
            : { items: [conversation], meta: { pagination: { next: null } } },
      })
    })
    await page
      .getByRole("button", { name: "Recent chats", exact: true })
      .click()
    const recent = page.getByRole("dialog", {
      name: "Recent chats",
      exact: true,
    })
    await expect(recent.getByRole("alert")).toContainText(
      "Couldn’t load recent chats."
    )
    await expect(recent.getByText("No recent chats yet.")).toHaveCount(0)
    failList = false
    await recent.getByRole("button", { name: "Retry", exact: true }).click()
    await recent
      .getByRole("button", { name: conversation.title, exact: true })
      .click()
    await expect(page.getByText(/Recipe draft interrupted/)).toBeVisible()
    await expect(page.getByText("Preparing a recipe draft…")).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Retry response" })
    ).toBeVisible()
    await page.reload()
    await expect(page.getByText(/Recipe draft interrupted/)).toBeVisible()
    const other = await context.newPage()
    await other.setViewportSize({ width, height: 850 })
    await other.goto("/")
    await expect(
      other.getByRole("textbox", { name: "Message Primo" })
    ).toBeEnabled()
    await expect(other.getByText(/Recipe draft interrupted/)).toHaveCount(0)
    await expect(
      other.getByRole("heading", { name: "How can I help in the kitchen?" })
    ).toBeVisible()
    await other
      .getByRole("button", { name: "Recent chats", exact: true })
      .click()
    await expect(
      other
        .getByRole("dialog", { name: "Recent chats", exact: true })
        .getByRole("button", { name: conversation.title, exact: true })
    ).toBeVisible()
    await other
      .getByRole("dialog", { name: "Recent chats", exact: true })
      .getByRole("button", { name: conversation.title, exact: true })
      .click()
    await expect(other.getByText(/Recipe draft interrupted/)).toBeVisible()
    await other.screenshot({
      path: `output/playwright/primo-recent-recovery-${width}.png`,
      fullPage: true,
    })
    await other.close()
  })
}

test("stable history API retains the real backend's private conversation boundary", async ({
  page,
  browser,
}) => {
  await signIn(page)
  const upload = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/primo/attachments") &&
      response.request().method() === "POST"
  )
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "Private synthetic recipe.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic recipe. Carrots 200 g."),
  })
  const response = await upload
  expect(response.status()).toBe(200)
  const conversationId = response.request().headers()["x-conversation-id"]!
  // An unsent attachment is not yet a saved conversation. Exercise a failed
  // send with an unavailable historical attachment: the user turn is saved,
  // then manifest admission fails before the synthetic model could be called.
  const send = await page.request.post("/api/primo/chat", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      conversationId,
      recipeRef: null,
      messages: [
        {
          id: "old-user",
          role: "user",
          parts: [{ type: "text", text: "A removed synthetic file" }],
          metadata: { attachmentIds: ["00000000-0000-4000-8000-000000000098"] },
        },
        {
          id: "new-user",
          role: "user",
          parts: [{ type: "text", text: "Help with this synthetic recipe" }],
        },
      ],
    },
  })
  expect(send.status()).toBe(400)
  expect(await send.json()).toEqual({
    error: expect.stringContaining("attachment is no longer available"),
  })
  const own = await page.request.get(
    `/api/primo/conversations?id=${conversationId}`
  )
  expect(own.status()).toBe(200)
  expect((await own.json()).item.conversation.id).toBe(conversationId)
  const editorContext = await browser.newContext()
  const editor = await editorContext.newPage()
  await signIn(editor, sharedEditorAccount)
  const foreign = await editor.request.get(
    `/api/primo/conversations?id=${conversationId}`
  )
  expect(foreign.status()).toBe(404)
  expect(await foreign.json()).toEqual({ error: "Conversation not found" })
  await editorContext.close()
})

test("an SSE response ending halfway through draft arguments becomes retryable", async ({
  page,
}) => {
  await signIn(page)
  await page.route("**/api/primo/chat", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body:
        [
          { type: "start", messageId: "answer" },
          {
            type: "tool-input-start",
            toolCallId: "draft",
            toolName: "draft_recipe",
          },
          {
            type: "tool-input-delta",
            toolCallId: "draft",
            inputTextDelta: '{"title":"Synthetic soup","yield":',
          },
          { type: "finish", finishReason: "length" },
        ]
          .map((part) => `data: ${JSON.stringify(part)}\n\n`)
          .join("") + "data: [DONE]\n\n",
    })
  )
  await page
    .getByRole("textbox", { name: "Message Primo" })
    .fill("Draft a soup recipe")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText("Recipe draft interrupted. Try again.")
  ).toBeVisible()
  await expect(page.getByText("Preparing a recipe draft…")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Retry response" })
  ).toBeVisible()
  await page.screenshot({
    path: "output/playwright/primo-interrupted-draft.png",
    fullPage: true,
  })
})

test("send acceptance, interruption and retry have one recovery path", async ({
  page,
}) => {
  await signIn(page)
  let scenario = "rejected"
  const sentIds: string[] = []
  await page.route("**/api/primo/chat", async (route) => {
    const user = route
      .request()
      .postDataJSON()
      .messages.findLast((row: { role: string }) => row.role === "user")
    sentIds.push(user.id)
    if (scenario === "rejected")
      return route.fulfill({ status: 400, json: { error: "Message rejected" } })
    if (scenario === "accepted-http")
      return route.fulfill({
        status: 502,
        headers: { "x-primo-accepted-message": user.id },
        json: { error: "Generation unavailable" },
      })
    const chunks =
      scenario === "complete"
        ? [
            { type: "start", messageId: "answer" },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "The retry completed." },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason: "stop" },
          ]
        : [
            { type: "start", messageId: "answer" },
            {
              type: "tool-input-available",
              toolCallId: "batch",
              toolName: "show_recipe_batch",
              input: { multiplier: 2 },
            },
            {
              type: "tool-output-available",
              toolCallId: "batch",
              output: {
                ok: true,
                tool: "show_recipe_batch",
                recipe: { title: "Synthetic soup" },
                label: "2×",
                portions: 4,
                cost: null,
                view: "/recipes/rcp_0123456789ab/cost?batch=2",
              },
            },
            { type: "error", errorText: "Provider disconnected" },
          ]
    await route.fulfill({
      contentType: "text/event-stream",
      headers: {
        "x-vercel-ai-ui-message-stream": "v1",
        "x-primo-accepted-message": user.id,
      },
      body:
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
    })
  })
  const composer = page.getByRole("textbox", { name: "Message Primo" })
  await composer.fill("Synthetic rejected question")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText("Couldn’t send. Your draft is ready to retry.")
  ).toBeVisible()
  await expect(composer).toHaveValue("Synthetic rejected question")
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Primo conversation" })
  ).toHaveCount(0)

  scenario = "accepted-http"
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(
    page.getByText("Primo couldn’t finish this question. Retry to continue.")
  ).toBeVisible()
  await expect(composer).toHaveValue("")
  await expect(page.getByText(/Couldn’t send/)).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(1)

  scenario = "partial"
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(
    page.getByText("Results loaded; response interrupted. Try again.")
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "View batch preview" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(1)
  await expect(
    page.getByText("Primo couldn’t finish this question. Retry to continue.")
  ).toHaveCount(0)
  await composer.fill("Keep this next question")
  scenario = "complete"
  await page
    .getByRole("button", { name: "Retry response", exact: true })
    .click()
  await expect(page.getByText("The retry completed.")).toBeVisible()
  await expect(composer).toHaveValue("Keep this next question")
  expect(new Set(sentIds.slice(1)).size).toBe(1)
  await expect(page.getByText(/response interrupted/)).toHaveCount(0)
})
