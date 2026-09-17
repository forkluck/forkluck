import { describe, expect, it, vi } from "vitest"

const headerStore = { host: null as string | null }

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === "host" ? headerStore.host : null,
  }),
}))

const { GET } = await import("@/app/robots.txt/route")

async function robotsFor(host: string | null) {
  headerStore.host = host
  const response = await GET()
  return { status: response.status, body: await response.text() }
}

describe("robots.txt", () => {
  it("lets crawlers index the visual guide host", async () => {
    const { status, body } = await robotsFor("design.forkluck.com")

    expect(status).toBe(200)
    expect(body).toBe("User-agent: *\nAllow: /\n")
  })

  it("keeps the application host out of every index", async () => {
    const { body } = await robotsFor("app.forkluck.com")

    expect(body).toBe("User-agent: *\nDisallow: /\n")
  })

  it("disallows when no host reaches the route", async () => {
    const { body } = await robotsFor(null)

    expect(body).toBe("User-agent: *\nDisallow: /\n")
  })
})
