import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { generateText } from "ai"

vi.mock("server-only", () => ({}))
import {
  primoConfigured,
  primoModel,
  type PrimoGatewayContext,
} from "@/lib/primo/model"

const context: PrimoGatewayContext = {
  version: 1,
  task: "title",
  userId: "owner",
  conversationId: "00000000-0000-4000-8000-000000000001",
  turnId: "turn-1",
  deadlineAt: Date.now() + 10000,
}
beforeEach(() => {
  vi.stubEnv("PRIMO_API_KEY", "installation-secret")
  vi.stubEnv("PRIMO_BASE_URL", "https://primo.example.invalid/v1")
  vi.stubEnv("QWEN_API_KEY", "invoice-secret")
})
afterEach(() => vi.unstubAllEnvs())

it("does not enable Primo when only the invoice provider key is configured", () => {
  vi.stubEnv("PRIMO_API_KEY", "")
  expect(primoConfigured()).toBe(false)
  expect(() => primoModel(context)).toThrow("not configured")
})
it.each([
  "http://external.test/v1",
  "https://key:secret@primo.test/v1",
  "https://primo.test/v1?key=secret",
  "https://primo.test/other",
  "not a URL",
])("rejects an invalid gateway address: %s", (url) => {
  vi.stubEnv("PRIMO_BASE_URL", url)
  expect(primoConfigured()).toBe(false)
})
it.each(["http://127.0.0.1:8011/v1", "https://primo.forkluck.com/v1"])(
  "accepts the configured service transport: %s",
  (url) => {
    vi.stubEnv("PRIMO_BASE_URL", url)
    expect(primoConfigured()).toBe(true)
  }
)
it("sends only the installation credential and server context through the real SDK", async () => {
  const requests: Array<{
    url: string
    headers: Headers
    body: Record<string, unknown>
  }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return Response.json({
      id: "synthetic",
      model: "primo",
      created: 1,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Kitchen chat" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }
  await generateText({
    model: primoModel(context, fakeFetch),
    prompt: "Soup question",
    maxOutputTokens: 40,
  })
  const request = requests[0]
  expect(request.url).toBe("https://primo.example.invalid/v1/chat/completions")
  expect(request.headers.get("authorization")).toBe(
    "Bearer installation-secret"
  )
  expect(request.body.primo_context).toEqual(context)
  expect(request.body.model).toBe("primo")
  expect(request.body.messages).toEqual([
    { role: "user", content: "Soup question" },
  ])
  expect(JSON.stringify(request)).not.toContain("invoice-secret")
})
