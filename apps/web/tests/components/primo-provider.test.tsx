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
  clearError: vi.fn(),
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
    | undefined
    | {
        onData?: (part: { type: string; data: unknown }) => void
        onError: (error: Error) => void
      },
  fetch: undefined as typeof fetch | undefined,
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
  useGuardedNavigate: () => ({ go: vi.fn(), pending: false }),
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
      clearError: chatFns.clearError,
    }
  },
}))
vi.mock("ai", () => ({
  DefaultChatTransport: class {
    constructor(options: unknown) {
      chatInit.fetch = (options as { fetch: typeof fetch }).fetch
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  state.pathname = "/ingredients"
  state.messages = []
  state.desktop = true
  state.error = undefined
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, "", "/")
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
  it("starts fresh despite another window's legacy active pointer", async () => {
    const id = "00000000-0000-4000-8000-000000000099"
    window.localStorage.setItem("primo:active", id)
    render(
      <PrimoProvider>
        <Probe />
      </PrimoProvider>
    )
    await waitFor(() =>
      expect(window.sessionStorage.getItem("primo:active")).toBe(
        screen.getByLabelText("conversation id").textContent
      )
    )
    expect(screen.getByLabelText("conversation id").textContent).not.toBe(id)
    expect(primoActions.load).not.toHaveBeenCalled()
    expect(window.localStorage.getItem("primo:active")).toBe(id)
  })

  it.each([
    ["owner", "owner", "", true],
    ["owner", "other", "", false],
    ["owner", "owner", "?c=not-a-uuid", true],
    ["owner", "owner", "?c=00000000-0000-4000-8000-000000000088", true],
  ])(
    "scopes remembered selection and gives valid links precedence (%s/%s/%s)",
    async (user, scope, search, restored) => {
      const stored = "00000000-0000-4000-8000-000000000099"
      const expected =
        search && !search.includes("not-a-uuid") ? search.slice(3) : stored
      window.sessionStorage.setItem(`primo:active:${scope}`, stored)
      window.history.replaceState(null, "", `/${search}`)
      primoActions.load.mockResolvedValue({
        item: {
          conversation: { id: expected, title: "Saved title" },
          messages: [],
        },
      })
      render(
        <PrimoProvider userId={user}>
          <Probe />
        </PrimoProvider>
      )
      await waitFor(() =>
        expect(window.sessionStorage.getItem(`primo:active:${user}`)).toBe(
          screen.getByLabelText("conversation id").textContent
        )
      )
      if (restored) {
        await waitFor(() =>
          expect(primoActions.load).toHaveBeenCalledWith(expected)
        )
        await waitFor(() =>
          expect(screen.getByLabelText("recent titles").textContent).toBe(
            "Saved title"
          )
        )
      } else {
        expect(primoActions.load).not.toHaveBeenCalled()
        expect(screen.getByLabelText("conversation id").textContent).not.toBe(
          stored
        )
      }
    }
  )

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
          parts: [{ type: "text", text: "Read this recipe instead" }],
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
    window.sessionStorage.setItem("primo:active", id)
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
    window.sessionStorage.setItem("primo:active", id)
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
    expect(window.sessionStorage.getItem("primo:active")).not.toBe(id)
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

  it("keeps the saved title until rename succeeds and preserves it on failure", async () => {
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
    expect(screen.getByLabelText("recent titles").textContent).toBe("Original")
    await waitFor(() =>
      expect(screen.getByLabelText("recent titles").textContent).toBe(
        "Original"
      )
    )
  })
})

// The transport response, not the SDK's optimistic user row, acknowledges acceptance.
it.each([
  [400, false, true],
  [401, false, true],
  [409, false, true],
  [503, false, true],
  [400, true, false],
  [502, true, false],
  [200, true, false],
  [502, false, false],
  [0, false, false],
])(
  "restores only definitively rejected sends (HTTP %s, accepted %s)",
  async (status, accepted, rejected) => {
    const outcome = vi.fn()
    const before = {
      id: "earlier",
      role: "user",
      parts: [{ type: "text", text: "Earlier question" }],
    }
    state.messages = [before]
    chatFns.sendMessage.mockImplementation(async (message) => {
      vi.stubGlobal(
        "fetch",
        status === 0
          ? vi.fn().mockRejectedValue(new TypeError("Network lost"))
          : vi.fn().mockResolvedValue(
              new Response("", {
                status,
                headers: accepted
                  ? { "x-primo-accepted-message": message.id }
                  : {},
              })
            )
      )
      try {
        await chatInit.fetch!("/api/primo/chat")
      } catch {}
      chatInit.value!.onError(new Error("Answer failed"))
    })
    function Send() {
      const { send, conversationLoading } = usePrimo()
      return (
        <button
          disabled={conversationLoading}
          onClick={() =>
            void send("New question").then(
              () => outcome("retained"),
              () => outcome("rejected")
            )
          }
        >
          Send test
        </button>
      )
    }
    render(
      <PrimoProvider>
        <Send />
      </PrimoProvider>
    )
    await waitFor(() =>
      expect(screen.getByText("Send test")).toHaveProperty("disabled", false)
    )
    await act(async () => fireEvent.click(screen.getByText("Send test")))
    expect(outcome).toHaveBeenCalledWith(rejected ? "rejected" : "retained")
    if (rejected) {
      expect(chatFns.setMessages).toHaveBeenCalledWith([before])
      expect(chatFns.clearError).toHaveBeenCalledOnce()
    } else expect(chatFns.clearError).not.toHaveBeenCalled()
  }
)
