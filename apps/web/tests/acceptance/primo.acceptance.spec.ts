import { expect, test } from "@playwright/test"

test("Primo admits the public origin behind a proxy and still rejects foreign origins", async ({
  request,
}) => {
  for (const [origin, status] of [
    ["https://app.forkluck.test", 401],
    ["https://elsewhere.test", 403],
    ["http://app.forkluck.test", 403],
    ["null", 403],
  ] as const) {
    const response = await request.post("/api/primo/chat", {
      headers: {
        host: "app.forkluck.test",
        origin,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "elsewhere.test",
      },
      data: {},
    })
    expect(response.status()).toBe(status)
    expect(await response.json()).toEqual({
      error: status === 401 ? "Authentication required." : "Not allowed.",
    })
  }
})
