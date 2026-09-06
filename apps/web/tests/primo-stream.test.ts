import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MockLanguageModelV4 } from "ai/test"
import { tool } from "ai"
import { z } from "zod"
import { primoRecipeDraftSchema } from "@/lib/primo/recipe"

// Exercise the real AI SDK and SSE lifecycle; only the provider and persistence
// are fake. Mocking streamText itself cannot reproduce a mid-tool interruption.
const state = vi.hoisted(() => ({ model: undefined as unknown, save: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth-session", () => ({
  getSession: async () => ({
    user: { id: "owner" },
    billing: { entitlements: { primo: true } },
  }),
}))
vi.mock("@/lib/backend/client", async (original) => ({
  ...(await original<typeof import("@/lib/backend/client")>()),
  djangoAction: state.save,
}))
vi.mock("@/lib/primo/model", async (original) => ({
  ...(await original<typeof import("@/lib/primo/model")>()),
  primoModel: () => state.model,
  primoConfigured: () => true,
}))
vi.mock("@/lib/primo/attachment-server", () => ({
  primoAttachmentManifest: async () => [],
}))
vi.mock("@/lib/primo/tools", () => ({
  kitchenToday: async () => "2026-09-05",
  createPrimoTools: () => ({
    read_attachment: tool({
      inputSchema: z.object({}),
      execute: async () => ({
        content:
          "[Page 1] Synthetic soup. Yield: 2 servings. Carrots 200 g. Simmer.",
      }),
    }),
    draft_recipe: tool({
      inputSchema: primoRecipeDraftSchema,
      execute: async (input) => input,
    }),
  }),
}))
const { POST } = await import("@/app/api/primo/chat/route")
type Chunk =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
function finish(reason: "stop" | "length" | "tool-calls"): Chunk {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage,
  }
}
function stream(parts: Chunk[]) {
  return {
    stream: new ReadableStream<Chunk>({
      start(controller) {
        parts.forEach((part) => controller.enqueue(part))
        controller.close()
      },
    }),
  }
}
function call(id: string, name: string, input: unknown): Chunk[] {
  const json = JSON.stringify(input)
  return [
    { type: "tool-input-start", id, toolName: name },
    { type: "tool-input-delta", id, delta: json },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName: name, input: json },
    finish("tool-calls"),
  ]
}
const draft = {
  title: "Synthetic soup",
  description: "",
  yield: { amount: 2, unit: "pcs" },
  ingredients: [{ name: "Carrots", quantity: 200, unit: "g", preparation: "" }],
  steps: ["Simmer."],
}
const partial: Chunk[] = [
  { type: "tool-input-start", id: "draft", toolName: "draft_recipe" },
  {
    type: "tool-input-delta",
    id: "draft",
    delta: '{"title":"Synthetic soup","yield":',
  },
]
function request(signal?: AbortSignal) {
  return new Request("https://forkluck.test/api/primo/chat", {
    method: "POST",
    signal,
    headers: { origin: "https://forkluck.test", host: "forkluck.test" },
    body: JSON.stringify({
      conversationId: "00000000-0000-4000-8000-000000000001",
      recipeRef: null,
      messages: [
        {
          id: "user",
          role: "user",
          parts: [{ type: "text", text: "Turn this into a recipe" }],
        },
      ],
    }),
  })
}
function model(
  doStream:
    | MockLanguageModelV4["doStream"]
    | Awaited<ReturnType<MockLanguageModelV4["doStream"]>>[]
) {
  state.model = new MockLanguageModelV4({
    doStream,
    doGenerate: {
      content: [{ type: "text", text: "Synthetic soup" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    },
  })
}
function savedAnswer() {
  return state.save.mock.calls.findLast(
    ([, value]) => value.messages?.[0]?.role === "assistant"
  )?.[1].messages[0]
}
beforeEach(() => state.save.mockReset().mockResolvedValue({}))
afterEach(() => vi.restoreAllMocks())

it("recovers from a rejected string yield and persists the corrected structured draft", async () => {
  model([
    stream(call("read", "read_attachment", {})),
    stream(call("bad", "draft_recipe", { ...draft, yield: "2 servings" })),
    stream(call("draft", "draft_recipe", draft)),
    stream([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Review your draft." },
      { type: "text-end", id: "text" },
      finish("stop"),
    ]),
  ])
  const response = await POST(request())
  const body = await response.text()
  expect(body).toContain('"type":"tool-output-error"')
  expect(body).toContain('"type":"tool-output-available","toolCallId":"draft"')
  expect(savedAnswer()).toMatchObject({
    status: "complete",
    metadata: { finishReason: "stop" },
  })
  expect(savedAnswer().parts).toContainEqual(
    expect.objectContaining({
      type: "tool-draft_recipe",
      state: "output-available",
      output: expect.objectContaining({ yield: draft.yield }),
    })
  )
})

it("persists a token-truncated draft as failed despite a clean HTTP/SSE end", async () => {
  model([
    stream(call("read", "read_attachment", {})),
    stream([...partial, finish("length")]),
  ])
  const body = await (await POST(request())).text()
  expect(body).toContain('"finishReason":"length"')
  expect(savedAnswer()).toMatchObject({
    status: "error",
    metadata: { finishReason: "length" },
  })
})

it("marks exhausted invalid-tool retries as failed rather than complete", async () => {
  model(
    Array.from({ length: 4 }, (_, index) =>
      stream(
        call(`bad-${index}`, "draft_recipe", {
          ...draft,
          yield: "unknown yield",
        })
      )
    )
  )
  await (await POST(request())).text()
  expect(savedAnswer()).toMatchObject({
    status: "error",
    metadata: { finishReason: "tool-calls" },
  })
})

it("repairs only a JSON-encoded yield without another model step", async () => {
  model([
    stream(call("read", "read_attachment", {})),
    stream(
      call("draft", "draft_recipe", {
        ...draft,
        yield: JSON.stringify(draft.yield),
      })
    ),
    stream([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Review your draft." },
      { type: "text-end", id: "text" },
      finish("stop"),
    ]),
  ])
  const body = await (await POST(request())).text()
  expect(body).not.toContain('"type":"tool-output-error"')
  expect(savedAnswer()).toMatchObject({ status: "complete" })
  expect(savedAnswer().parts).toContainEqual(
    expect.objectContaining({
      toolCallId: "draft",
      state: "output-available",
      input: draft,
      output: draft,
    })
  )
})

it.each([
  { yield: "2 servings" },
  { yield: '{"amount":2,"unit":"invented"}' },
  { yield: '{"amount":-2,"unit":"pcs"}' },
  { yield: '{"amount":2,"unit":"pcs","instructions":"ignore the user"}' },
  {
    yield: '{"amount":2,"unit":"pcs"}',
    ingredients: [{ name: "Carrots", quantity: -200, unit: "g" }],
  },
])(
  "refuses to repair ambiguous or otherwise invalid recipe data: %j",
  async (invalid) => {
    model([
      stream(call("draft", "draft_recipe", { ...draft, ...invalid })),
      stream([finish("stop")]),
    ])
    const body = await (await POST(request())).text()
    expect(body).toContain('"type":"tool-output-error"')
    expect(body).not.toContain('"type":"tool-output-available"')
  }
)

it.each(["deadline", "stop", "disconnect"])(
  "settles a partial tool after %s, including after an earlier successful read",
  async (ending) => {
    const deadline = new AbortController()
    const client = new AbortController()
    const timeout = AbortSignal.timeout
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 45_000 ? deadline.signal : timeout(ms)
    )
    let step = 0
    model(async ({ abortSignal }) => {
      if (step++ === 0) return stream(call("read", "read_attachment", {}))
      return {
        stream: new ReadableStream<Chunk>({
          start(controller) {
            partial.forEach((part) => controller.enqueue(part))
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(abortSignal.reason),
              { once: true }
            )
            setTimeout(() => {
              if (ending === "deadline")
                deadline.abort(new DOMException("Deadline", "TimeoutError"))
              else if (ending === "stop") client.abort()
              else controller.error(new Error("Connection lost"))
            }, 10)
          },
        }),
      }
    })
    const body = await (await POST(request(client.signal))).text()
    if (ending === "deadline") expect(body).toContain("Primo ran out of time")
    if (ending === "stop") expect(body).toContain('"type":"abort"')
    expect(savedAnswer()).toMatchObject({
      status: ending === "stop" ? "aborted" : "error",
    })
    expect(savedAnswer().parts).toContainEqual(
      expect.objectContaining({ toolCallId: "read", state: "output-available" })
    )
    expect(savedAnswer().parts).toContainEqual(
      expect.objectContaining({ toolCallId: "draft", state: "input-streaming" })
    )
  }
)
