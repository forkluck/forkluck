// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const state = vi.hoisted(() => ({
  chat: {
    messages: [] as Array<Record<string, unknown>>,
    status: "ready" as "ready" | "submitted" | "streaming" | "error",
    error: undefined as Error | undefined,
    regenerate: vi.fn(),
    stop: vi.fn(),
  },
  send: vi.fn(),
  route: {
    recipeRef: null as string | null,
    productRef: null as string | null,
  },
  conversationId: "00000000-0000-4000-8000-000000000001",
  conversationLoading: false,
}))

vi.mock("@/components/primo/primo-provider", () => ({
  usePrimo: () => ({
    chat: state.chat,
    send: state.send,
    route: state.route,
    conversationId: state.conversationId,
    conversationLoading: state.conversationLoading,
  }),
}))
vi.mock("@/app/(app)/actions", () => ({ runKitchenToolAction: vi.fn() }))
vi.mock("@/app/(app)/recipes/actions", () => ({
  createRecipeFromDraft: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

import { PrimoConversation } from "@/components/primo/primo-conversation"

beforeEach(() => {
  state.chat.messages = []
  state.chat.status = "ready"
  state.chat.error = undefined
  state.send.mockReset()
  state.route.recipeRef = null
  state.route.productRef = null
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(cleanup)

describe("Primo conversation", () => {
  it.each(["input-streaming", "input-available"])(
    "settles an unfinished %s recipe step when the stream ends and after reload",
    (toolState) => {
      state.chat.status = "streaming"
      state.chat.messages = [
        {
          id: "draft",
          role: "assistant",
          parts: [
            {
              type: "tool-draft_recipe",
              toolCallId: "call",
              state: toolState,
              input: {},
            },
          ],
        },
      ]
      const view = render(<PrimoConversation userName="Ada" />)
      expect(screen.getByText("Preparing a recipe draft…")).toBeDefined()
      for (const status of [undefined, "complete", "error"]) {
        state.chat.status = "ready"
        state.chat.messages[0]!.status = status
        view.rerender(<PrimoConversation userName="Ada" />)
        expect(screen.queryByText("Preparing a recipe draft…")).toBeNull()
        expect(screen.getByText(/Recipe draft interrupted/)).toBeDefined()
      }
    }
  )

  it("does not revive an older unfinished tool while a new answer streams", () => {
    state.chat.status = "streaming"
    state.chat.messages = [
      {
        id: "old",
        role: "assistant",
        parts: [
          {
            type: "tool-draft_recipe",
            toolCallId: "old-call",
            state: "input-available",
            input: {},
          },
        ],
      },
      {
        id: "new-user",
        role: "user",
        parts: [{ type: "text", text: "Try again" }],
      },
    ]
    render(<PrimoConversation userName="Ada" />)
    expect(screen.queryByText("Preparing a recipe draft…")).toBeNull()
    expect(screen.getByText(/Recipe draft interrupted/)).toBeDefined()
  })

  it("names a draft validation failure as drafting, not a kitchen read", () => {
    state.chat.messages = [
      {
        id: "draft",
        role: "assistant",
        parts: [
          {
            type: "tool-draft_recipe",
            toolCallId: "bad-yield",
            state: "output-error",
            errorText: "yield must be object",
          },
        ],
      },
    ]
    render(<PrimoConversation userName="Ada" />)
    expect(
      screen.getByText("Recipe draft interrupted. Try again.")
    ).toBeDefined()
  })
  it("uses the persistent provider to send a normal kitchen question", () => {
    render(<PrimoConversation userName="Ada Lovelace" />)
    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    fireEvent.change(composer, { target: { value: "Draft a tomato soup" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(state.send).toHaveBeenCalledWith("Draft a tomato soup", [])
  })

  it("renders sales, batch, and failure tool output", () => {
    state.chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-get_product_sales",
            toolCallId: "sales-1",
            state: "output-available",
            input: {},
            output: {
              ok: true,
              tool: "get_product_sales",
              product: { name: "Mooncake", baseUnit: "each" },
              period: { label: "Aug 1 – 31, 2026" },
              units: 412,
              netSalesCents: 288_400,
              currencyCode: "USD",
            },
          },
          {
            type: "tool-show_recipe_batch",
            toolCallId: "batch-1",
            state: "output-available",
            input: { portions: 600 },
            output: {
              ok: true,
              tool: "show_recipe_batch",
              recipe: { title: "Mooncake" },
              label: "50x",
              portions: 600,
              cost: null,
              view: "/recipes/rcp_0123456789ab/cost?batch=50",
            },
          },
          {
            type: "tool-get_recipe_cost_change",
            toolCallId: "cost-1",
            state: "output-available",
            input: {},
            output: {
              ok: false,
              tool: "get_recipe_cost_change",
              reason: "owner_only",
              message: "Only the recipe's owner can compare its cost history.",
            },
          },
        ],
      },
    ]
    render(<PrimoConversation userName="Ada" />)
    expect(screen.queryByText(/Mooncake · Aug 1/)).toBeNull()
    expect(screen.getByText(/Mooncake at 50x/)).toBeDefined()
    expect(screen.getByText(/preview ready/)).toBeDefined()
    expect(screen.getByText(/cost unavailable/)).toBeDefined()
    expect(
      screen
        .getByRole("link", { name: "View batch preview" })
        .getAttribute("href")
    ).toBe("/recipes/rcp_0123456789ab/cost?batch=50")
    expect(
      screen.getByText(/Only the recipe.s owner can compare its cost history/)
    ).toBeDefined()
  })

  it("renders progress markers for each kitchen read", () => {
    state.chat.status = "streaming"
    state.chat.messages = [
      {
        id: "assistant-progress",
        role: "assistant",
        parts: [
          {
            type: "tool-get_product_sales",
            toolCallId: "sales-progress",
            state: "input-available",
            input: {},
          },
          {
            type: "tool-show_recipe_batch",
            toolCallId: "batch-progress",
            state: "input-available",
            input: { portions: 600 },
          },
        ],
      },
    ]
    render(<PrimoConversation userName="Ada" />)
    expect(screen.getByText("Reading sales…")).toBeDefined()
    expect(
      screen.getByText("Preparing a preview for 600 portions…")
    ).toBeDefined()
  })

  it.each([{ ambiguous: [] }, { ambiguous: ["mooncake"] }])(
    "sends ordinary and ambiguous choices as bound mentions (%s)",
    ({ ambiguous }) => {
      state.chat.messages = [
        {
          id: "assistant-choice",
          role: "assistant",
          parts: [
            {
              type: "tool-find_products",
              toolCallId: "products-1",
              state: "output-available",
              input: { query: "moon" },
              output: {
                ok: true,
                tool: "find_products",
                query: "moon",
                more: false,
                ambiguous,
                products: [
                  {
                    productRef: "prd_0123456789ab",
                    name: "Mooncake",
                    sku: "MOON-1",
                    baseUnit: "each",
                    recipes: [],
                  },
                  {
                    productRef: "prd_bbbbbbbbbbbb",
                    name: "Mooncake",
                    sku: "MOON-2",
                    baseUnit: "each",
                    recipes: [],
                  },
                ],
              },
            },
          ],
        },
      ]
      render(<PrimoConversation userName="Ada" />)
      fireEvent.click(screen.getByRole("button", { name: "Mooncake (MOON-1)" }))
      expect(state.send).toHaveBeenCalledWith("@Mooncake (MOON-1)", [
        {
          kind: "product",
          label: "Mooncake (MOON-1)",
          ref: "prd_0123456789ab",
        },
      ])
    }
  )

  it("removes response actions while streaming and offers copy and last-response regenerate after", () => {
    state.chat.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "First answer" }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "Latest answer" }],
      },
    ]
    state.chat.status = "streaming"
    const view = render(<PrimoConversation userName="Ada" />)
    expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull()

    state.chat.status = "ready"
    view.rerender(<PrimoConversation userName="Ada" />)
    const copy = screen.getAllByRole("button", { name: "Copy response" })[1]!
    fireEvent.click(copy)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Latest answer")
    expect(
      screen.getAllByRole("button", { name: "Regenerate response" })
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }))
    expect(state.chat.regenerate).toHaveBeenCalled()
  })

  it("renders a persisted aborted tool call as stopped, not live", () => {
    state.chat.messages = [
      {
        id: "assistant-stopped",
        role: "assistant",
        status: "aborted",
        parts: [
          {
            type: "tool-get_product_sales",
            toolCallId: "stopped-call",
            state: "input-available",
            input: {},
          },
        ],
      },
    ]
    render(<PrimoConversation userName="Ada" />)
    expect(screen.getByText("Response stopped")).toBeDefined()
    expect(screen.queryByText("Reading sales…")).toBeNull()
  })

  it("announces the live turn and shows elapsed time after three seconds", () => {
    vi.useFakeTimers()
    state.chat.status = "submitted"
    render(<PrimoConversation userName="Ada" />)
    expect(screen.getByRole("status").textContent).toContain(
      "Primo is answering"
    )
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByText("3s")).toBeDefined()
    vi.useRealTimers()
  })
})

it("retains successful data, offers one retry, and announces interruption", () => {
  state.chat.status = "error"
  state.chat.error = new Error("Network lost")
  state.chat.messages = [
    {
      id: "answer",
      role: "assistant",
      status: "error",
      parts: [
        {
          type: "tool-show_recipe_batch",
          toolCallId: "batch",
          state: "output-available",
          input: {},
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
        {
          type: "tool-draft_recipe",
          toolCallId: "draft",
          state: "input-streaming",
          input: {},
        },
      ],
    },
  ]
  render(<PrimoConversation userName="Ada" />)
  expect(screen.getByText(/Synthetic soup at 2×/)).toBeDefined()
  expect(
    screen.getByText("Results loaded; response interrupted. Try again.")
  ).toBeDefined()
  expect(screen.getAllByRole("button", { name: /Retry/ })).toHaveLength(1)
  expect(
    screen.queryByRole("button", { name: "Regenerate response" })
  ).toBeNull()
  expect(screen.getByRole("status").textContent).toBe(
    "Primo’s response was interrupted"
  )
  expect(screen.queryByText(/Couldn’t send/)).toBeNull()
})

it("collapses a repaired schema failure after a valid final draft", () => {
  state.chat.messages = [
    {
      id: "answer",
      role: "assistant",
      status: "complete",
      parts: [
        {
          type: "tool-draft_recipe",
          toolCallId: "bad",
          state: "output-error",
          errorText: "yield must be object",
          input: { yield: "2 servings" },
        },
        {
          type: "tool-draft_recipe",
          toolCallId: "good",
          state: "output-available",
          input: {},
          output: {
            title: "Synthetic soup",
            description: "",
            yield: { amount: 2, unit: "pcs" },
            ingredients: [
              { name: "Carrots", quantity: 200, unit: "g", preparation: "" },
            ],
            steps: ["Simmer."],
          },
        },
      ],
    },
  ]
  render(<PrimoConversation userName="Ada" />)
  expect(
    screen.queryByText(/interrupted|not completed|yield must be/)
  ).toBeNull()
  expect(screen.getByText(/Recipe draft · completed/)).toBeDefined()
  expect(screen.getByRole("button", { name: "Create recipe" })).toBeDefined()
})

it("edits a question with its original files and only still-present mentions, leaving the composer draft separate", async () => {
  const file = {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Recipe.txt",
    mediaType: "text/plain",
    size: 25,
    coverage: "Complete",
  }
  const mention = { kind: "recipe", ref: "rcp_0123456789ab", label: "Cookies" }
  state.chat.messages = [
    {
      id: "question",
      role: "user",
      parts: [{ type: "text", text: "Read @Cookies and @Cake" }],
      metadata: {
        mentions: [
          mention,
          { ...mention, label: "Cake", ref: "rcp_bbbbbbbbbbbb" },
        ],
        attachments: [file],
        attachmentIds: [file.id],
      },
    },
    {
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "Earlier answer" }],
    },
  ]
  render(<PrimoConversation userName="Ada" />)
  fireEvent.change(screen.getByRole("textbox", { name: "Message Primo" }), {
    target: { value: "Unsent next question" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Edit question" }))
  expect(screen.getByText(/removes all later messages/)).toBeDefined()
  fireEvent.change(screen.getByRole("textbox", { name: "Edit question" }), {
    target: { value: "Compare @Cookies" },
  })
  state.send.mockRejectedValueOnce(
    new Error("This chat changed. Reload it before editing.")
  )
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save and resend" }))
  )
  expect(screen.getByRole("alert").textContent).toContain("This chat changed")
  expect(screen.getByRole("textbox", { name: "Edit question" })).toHaveProperty(
    "value",
    "Compare @Cookies"
  )
  state.send.mockResolvedValueOnce(undefined)
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save and resend" }))
  )
  expect(state.send).toHaveBeenLastCalledWith(
    "Compare @Cookies",
    [mention],
    [file],
    "question"
  )
  expect(screen.queryByRole("textbox", { name: "Edit question" })).toBeNull()
  expect(screen.getByRole("textbox", { name: "Message Primo" })).toHaveProperty(
    "value",
    "Unsent next question"
  )
})

it.each([
  "get_product_sales",
  "get_recipe_cost_change",
  "get_top_products",
  "get_ingredient_price_changes",
  "calculate_batch_cost",
  "search_usda_foods",
])(
  "shows one written answer for %s and keeps a missing answer retryable",
  (tool) => {
    const text =
      "Synthetic flour fell from $0.44 to $0.26. The exact target price is $2.875, rounded up to $2.88."
    const output = {
      ok: true,
      tool,
      recipe: { publicId: "rcp_0123456789ab" },
      lines: [],
      priceChangesInWindow: 1,
      view:
        tool === "get_recipe_cost_change"
          ? "/recipes/rcp_0123456789ab/cost"
          : "/analytics?start=2026-08-01&end=2026-08-31",
    }
    const parts = [
      { type: "text", text: "I’ll check that." },
      {
        type: `tool-${tool}`,
        toolCallId: "read",
        state: "output-available",
        input: {},
        output,
      },
      { type: "text", text },
    ]
    state.chat.messages = [{ id: "result", role: "assistant", parts }]
    const view = render(<PrimoConversation userName="Ada" />)
    expect(screen.getAllByText(text)).toHaveLength(1)
    expect(
      screen.queryByRole("heading", {
        name: /Top products|Ingredient price changes|Hypothetical batch costs/,
      })
    ).toBeNull()
    expect(document.querySelector("section.rounded-xl.border")).toBeNull()
    expect(screen.queryByRole("button", { name: "Retry response" })).toBeNull()
    expect(
      screen.getByRole("link", {
        name:
          tool === "get_recipe_cost_change"
            ? "Open Cost tab"
            : "View sales report",
      })
    ).toBeDefined()

    // A preamble before the tool is not a finished answer, including in restored history.
    state.chat.messages[0]!.parts = parts.slice(0, -1)
    state.chat.status = "streaming"
    view.rerender(<PrimoConversation userName="Ada" />)
    expect(screen.getByText("Primo is working on that…")).toBeDefined()
    expect(
      screen.queryByText("Results loaded; response interrupted. Try again.")
    ).toBeNull()
    state.chat.status = "ready"
    view.rerender(<PrimoConversation userName="Ada" />)
    expect(
      screen.getByText("Results loaded; response interrupted. Try again.")
    ).toBeDefined()
    expect(screen.getByRole("button", { name: "Retry response" })).toBeDefined()
    expect(screen.getByText("Primo’s response was interrupted")).toBeDefined()
  }
)

it("keeps fresh Home free of conversation-history shortcuts", () => {
  render(<PrimoConversation userName="Ada" home />)
  expect(
    screen.getByRole("heading", { name: "How can I help in the kitchen?" })
  ).toBeDefined()
  expect(
    screen.queryByRole("region", { name: "Recent conversations" })
  ).toBeNull()
  expect(screen.queryByText("Pick up where you left off")).toBeNull()
})
