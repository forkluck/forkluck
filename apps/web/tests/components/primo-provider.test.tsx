// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const state = vi.hoisted(() => ({
  pathname: "/ingredients",
  messages: [] as Array<Record<string, unknown>>,
  desktop: true,
  error: undefined as Error | undefined,
}))
const push = vi.hoisted(() => vi.fn())
const confirmNavigation = vi.hoisted(() => vi.fn())
const allowNavigation = vi.hoisted(() => vi.fn())
const chatFns = vi.hoisted(() => ({
  setMessages: vi.fn(),
  stop: vi.fn(),
  sendMessage: vi.fn(),
  regenerate: vi.fn(),
}))
const primoActions = vi.hoisted(() => ({
  load: vi.fn(),
  list: vi.fn(),
  rename: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}))
const chatInit = vi.hoisted(() => ({
  value: undefined as
    undefined | { onData?: (part: { type: string; data: unknown }) => void },
}))

vi.mock("@/app/(app)/actions", () => ({
  renamePrimoConversation: primoActions.rename,
  archivePrimoConversation: primoActions.archive,
  deletePrimoConversation: primoActions.remove,
}))

vi.mock("@/lib/primo/conversations", () => ({
  loadPrimoConversation: primoActions.load,
  listPrimoConversations: primoActions.list,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push }),
}))
vi.mock("@/components/navigation-blocker", () => ({
  useNavigationBlocker: () => ({ confirmNavigation, allowNavigation }),
}))
vi.mock("@ai-sdk/react", () => ({
  useChat: (options: unknown) => {
    chatInit.value = options as typeof chatInit.value
    return {
      messages: state.messages,
      sendMessage: chatFns.sendMessage,
      status: "ready",
      error: state.error,
      regenerate: chatFns.regenerate,
      stop: chatFns.stop,
      setMessages: chatFns.setMessages,
    }
  },
}))
vi.mock("ai", () => ({
  DefaultChatTransport: class {
    constructor(options: unknown) {
      void options
    }
  },
  isToolUIPart: (part: { type?: string }) =>
    part.type?.startsWith("tool-") ?? false,
}))

import {
  PrimoProvider,
  primoRouteContext,
  usePrimo,
} from "@/components/primo/primo-provider"

function Probe() {
  const { open, conversationId, newChat, conversations, renameConversation } =
    usePrimo()
  return (
    <>
      <output>{open ? "open" : "closed"}</output>
      <output aria-label="conversation id">{conversationId}</output>
      <button type="button" onClick={newChat}>
        New test chat
      </button>
      <output aria-label="recent titles">
        {conversations.map((row) => row.title).join(",")}
      </output>
      <button
        type="button"
        onClick={() => void renameConversation(conversationId, "Renamed")}
      >
        Rename test chat
      </button>
    </>
  )
}

afterEach(cleanup)

beforeEach(() => {
  state.pathname = "/ingredients"
  state.messages = []
  state.desktop = true
  state.error = undefined
  vi.clearAllMocks()
  window.localStorage.clear()
  primoActions.load.mockResolvedValue({ error: "not found" })
  primoActions.list.mockResolvedValue({ items: [] })
  confirmNavigation.mockResolvedValue(true)
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches: state.desktop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
})

describe("PrimoProvider", () => {
  it.each([false, true])(
    "retries a revised failed prompt with its bound attachment and original message id (additional file: %s)",
    async (additional) => {
      const file = {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Recipe.txt",
        size: 11,
        mediaType: "text/plain",
        coverage: "Read document text.",
      }
      state.messages = [
        {
          id: "failed-user",
          role: "user",
          parts: [{ type: "text", text: "Read this" }],
          metadata: { attachmentIds: [file.id] },
        },
      ]
      state.error = new Error("Disconnected")
      function Retry() {
        const { send, conversationLoading } = usePrimo()
        return (
          <button
            disabled={conversationLoading}
            onClick={() =>
              void send(
                "Read this recipe instead",
                [],
                [
                  file,
                  ...(additional
                    ? [{ ...file, id: "00000000-0000-4000-8000-000000000003" }]
                    : []),
                ]
              )
            }
          >
            Retry with revision
          </button>
        )
      }
      render(
        <PrimoProvider>
          <Retry />
        </PrimoProvider>
      )
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "Retry with revision",
            }) as HTMLButtonElement
          ).disabled
        ).toBe(false)
      )
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Retry with revision" })
        )
      )
      expect(chatFns.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "failed-user",
          text: "Read this recipe instead",
        })
      )
    }
  )
  it("reads recipe, product, and empty route context", () => {
    expect(primoRouteContext("/recipes/rcp_0123456789ab/cost")).toEqual({
      recipeRef: "rcp_0123456789ab",
      productRef: null,
    })
    expect(primoRouteContext("/products/prd_0123456789ab")).toEqual({
      recipeRef: null,
      productRef: "prd_0123456789ab",
    })
    expect(primoRouteContext("/ingredients")).toEqual({
      recipeRef: null,
      productRef: null,
    })
  })

  it("never navigates for new or restored tool results", async () => {
    state.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-show_recipe_batch",
            state: "output-available",
            toolCallId: "call-1",
            output: {
              ok: true,
              view: "/recipes/rcp_0123456789ab/cost?batch=50",
            },
          },
        ],
      },
    ]
    const view = render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await Promise.resolve()
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByText("closed")).toBeDefined()

    view.rerender(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await Promise.resolve()
    expect(push).not.toHaveBeenCalled()

    state.messages = [
      {
        ...state.messages[0],
        parts: [
          ...(state.messages[0]!.parts as unknown[]),
          {
            type: "tool-get_recipe_cost_change",
            state: "output-available",
            toolCallId: "call-2",
            output: { ok: true, view: "/recipes/rcp_0123456789ab/cost" },
          },
        ],
      },
    ]
    view.rerender(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await Promise.resolve()
    expect(push).not.toHaveBeenCalled()
  })

  it("keeps mobile chat in place when a tool returns a view", async () => {
    state.desktop = false
    state.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-get_product_sales",
            state: "output-available",
            toolCallId: "mobile-call",
            output: { ok: true, view: "/products/prd_0123456789ab" },
          },
        ],
      },
    ]
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await Promise.resolve()
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByText("closed")).toBeDefined()
  })

  it("does not prompt to leave a dirty editor when a tool completes", async () => {
    confirmNavigation.mockResolvedValue(false)
    state.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-get_product_sales",
            state: "output-available",
            toolCallId: "refused-call",
            output: { ok: true, view: "/products/prd_0123456789ab" },
          },
        ],
      },
    ]
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await Promise.resolve()
    expect(confirmNavigation).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(allowNavigation).not.toHaveBeenCalled()
  })

  it("restores the active conversation and loads its persisted messages", async () => {
    const id = "00000000-0000-4000-8000-000000000099"
    window.localStorage.setItem("primo:active", id)
    primoActions.load.mockResolvedValue({
      item: {
        conversation: { id },
        messages: [
          {
            id: "saved-user",
            role: "user",
            parts: [{ type: "text", text: "Saved" }],
          },
        ],
      },
    })
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await waitFor(() => expect(primoActions.load).toHaveBeenCalledWith(id))
    await waitFor(() =>
      expect(chatFns.setMessages).toHaveBeenCalledWith([
        {
          id: "saved-user",
          role: "user",
          parts: [{ type: "text", text: "Saved" }],
        },
      ])
    )
  })

  it("forgets a remembered conversation that no longer exists and starts fresh", async () => {
    const id = "00000000-0000-4000-8000-000000000098"
    window.localStorage.setItem("primo:active", id)
    primoActions.load.mockResolvedValue({ error: "Conversation not found" })
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await waitFor(() => expect(primoActions.load).toHaveBeenCalledWith(id))
    await waitFor(() =>
      expect(screen.getByLabelText("conversation id").textContent).not.toBe(id)
    )
    expect(window.localStorage.getItem("primo:active")).not.toBe(id)
    expect(screen.queryByText("Conversation not found")).toBeNull()
  })

  it("stops and clears the current turn before minting a new chat", () => {
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    const before = screen.getByLabelText("conversation id").textContent
    fireEvent.click(screen.getByRole("button", { name: "New test chat" }))
    const after = screen.getByLabelText("conversation id").textContent
    expect(chatFns.stop).toHaveBeenCalled()
    expect(chatFns.setMessages).toHaveBeenCalledWith([])
    expect(after).not.toBe(before)
  })

  it("optimistically renames a titled conversation and rolls back on failure", async () => {
    primoActions.rename.mockResolvedValueOnce({ error: "Nope" })
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    const id = screen.getByLabelText("conversation id").textContent!
    act(() => {
      chatInit.value?.onData?.({
        type: "data-title",
        data: { conversationId: id, title: "Original" },
      })
    })
    expect(screen.getByLabelText("recent titles").textContent).toBe("Original")
    fireEvent.click(screen.getByRole("button", { name: "Rename test chat" }))
    expect(screen.getByLabelText("recent titles").textContent).toBe("Renamed")
    await waitFor(() =>
      expect(screen.getByLabelText("recent titles").textContent).toBe(
        "Original"
      )
    )
  })
})
