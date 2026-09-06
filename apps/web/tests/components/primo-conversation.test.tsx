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
  createPrimoRecipe: vi.fn(),
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
      screen.getByText("Primo couldn’t prepare that recipe draft.")
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
    expect(screen.getByText(/Mooncake · Aug 1/)).toBeDefined()
    expect(screen.getByText(/Mooncake at 50x/)).toBeDefined()
    expect(
      screen.getByText("Only the recipe's owner can compare its cost history.")
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
    expect(screen.getByText("Scaling to 600 portions…")).toBeDefined()
  })

  it("sends ambiguity choices as a bound mention", () => {
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
              ambiguous: ["mooncake"],
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
  })

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
    expect(screen.getByText("Stopped")).toBeDefined()
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
