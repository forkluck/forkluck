import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

// The client is a server-only module: `server-only` has no runtime entry
// outside the Next.js bundler, and `next/headers` needs a live request.
vi.mock("server-only", () => ({}))

const incomingCookie = "sessionid=abc123; csrftoken=xyz789"
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: incomingCookie }),
}))
// Next's redirect throws to leave the render; the test reads the href off it.
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`)
  },
}))

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function loadClient() {
  return import("../lib/backend/client")
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("FORKLUCK_INTERNAL_SECRET", "test-internal-secret")
  vi.stubEnv("DJANGO_INTERNAL_ORIGIN", "http://127.0.0.1:8001")
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("date reviver", () => {
  it("revives exactly the allowlisted timestamp keys", async () => {
    // Mirrors the allowlist in docs/CONTRACT.md.
    const timestamp = "2026-03-04T05:06:07+00:00"
    const revived = [
      "createdAt",
      "updatedAt",
      "effectiveAt",
      "undoneAt",
      "clockIn",
      "clockOut",
      "firstShiftAt",
      "lastShiftAt",
      "soldAt",
      "lastSoldAt",
    ]
    fetchMock.mockResolvedValue(
      jsonResponse(Object.fromEntries(revived.map((key) => [key, timestamp])))
    )

    const { djangoGet } = await loadClient()
    const payload = await djangoGet<Record<string, unknown>>("/internal/v1/x/")

    for (const key of revived) {
      expect(payload[key]).toBeInstanceOf(Date)
      expect((payload[key] as Date).toISOString()).toBe(
        "2026-03-04T05:06:07.000Z"
      )
    }
  })

  it("leaves every other key a string, including date-only fields", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        // Date-only fields must not be shifted into a timezone-bearing Date.
        periodStart: "2026-03-04",
        periodEnd: "2026-03-05",
        invoiceDate: "2026-03-06",
        effectiveFrom: "2026-03-07",
        currentRateEffectiveFrom: "2026-03-08",
        // A timestamp under a key outside the allowlist stays a string.
        lastSeenAt: "2026-03-04T05:06:07+00:00",
        connectedAt: "2026-03-04T05:06:07+00:00",
        nested: {
          createdAt: "2026-03-04T05:06:07+00:00",
          soldOn: "2026-03-04",
        },
      })
    )

    const { djangoGet } = await loadClient()
    const payload = await djangoGet<
      Record<string, unknown> & { nested: Record<string, unknown> }
    >("/internal/v1/x/")

    for (const key of [
      "periodStart",
      "periodEnd",
      "invoiceDate",
      "effectiveFrom",
      "currentRateEffectiveFrom",
      "lastSeenAt",
      "connectedAt",
    ]) {
      expect(typeof payload[key]).toBe("string")
    }
    // Revival is by key, at any depth.
    expect(payload.nested.createdAt).toBeInstanceOf(Date)
    expect(typeof payload.nested.soldOn).toBe("string")
  })
})

describe("request headers", () => {
  it("forwards the internal secret and the incoming cookie", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    const { djangoGet } = await loadClient()
    await djangoGet("/internal/v1/session/")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("http://127.0.0.1:8001/internal/v1/session/")
    expect(init.cache).toBe("no-store")
    expect(init.headers["X-Forkluck-Internal-Secret"]).toBe(
      "test-internal-secret"
    )
    expect(init.headers.Cookie).toBe(incomingCookie)
    expect(init.headers.Accept).toBe("application/json")
  })

  it("posts an action body to the action route", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))

    const { djangoAction } = await loadClient()
    await djangoAction("save-recipe", { title: "Focaccia" })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      "http://127.0.0.1:8001/internal/v1/actions/save-recipe/"
    )
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ title: "Focaccia" }))
    expect(init.headers["X-Forkluck-Internal-Secret"]).toBe(
      "test-internal-secret"
    )
    expect(init.headers.Cookie).toBe(incomingCookie)
  })
})

describe("error handling", () => {
  it("turns a 401 into BackendUnauthorizedError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Authentication required" }, 401)
    )

    const { BackendUnauthorizedError, djangoGet } = await loadClient()
    await expect(djangoGet("/internal/v1/session/")).rejects.toBeInstanceOf(
      BackendUnauthorizedError
    )
  })

  it("raises the backend's error message on a non-ok response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Recipe title is required" }, 400)
    )

    const { djangoGet } = await loadClient()
    await expect(djangoGet("/internal/v1/recipes/")).rejects.toThrow(
      "Recipe title is required"
    )
  })

  it("falls back to the status code when there is no error message", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }))

    const { djangoGet } = await loadClient()
    await expect(djangoGet("/internal/v1/recipes/")).rejects.toThrow(
      "Forkluck backend returned 500"
    )
  })

  it("rejects an ok response that is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>nope</html>"))

    const { djangoGet } = await loadClient()
    await expect(djangoGet("/internal/v1/recipes/")).rejects.toThrow(
      "Forkluck backend returned an invalid response"
    )
  })
})

describe("djangoGetParsed", () => {
  const schema = z.strictObject({ items: z.array(z.string()) })

  it("returns the payload the backend sent, not a schema copy", async () => {
    const body = { items: ["a", "b"] }
    fetchMock.mockResolvedValue(jsonResponse(body))

    const { djangoGetParsed } = await loadClient()
    const payload = await djangoGetParsed("/internal/v1/x/", schema)

    expect(payload).toEqual(body)
  })

  it("raises outside production when the payload drifts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: ["a"], extra: 1 }))

    const { djangoGetParsed } = await loadClient()
    await expect(djangoGetParsed("/internal/v1/x/", schema)).rejects.toThrow()
  })

  it("keeps unknown keys on the value it returns", async () => {
    const loose = z.looseObject({ items: z.array(z.string()) })
    fetchMock.mockResolvedValue(jsonResponse({ items: [], extra: 1 }))

    const { djangoGetParsed } = await loadClient()
    const payload = await djangoGetParsed<Record<string, unknown>>(
      "/internal/v1/x/",
      loose
    )

    expect(payload.extra).toBe(1)
  })
})

describe("getLaborOverview comparison round-trip", () => {
  it("sends the selected comparison verbatim instead of dropping the default", async () => {
    // "Previous period" resolves to `prior_day`. The labor endpoint defaults an
    // absent comparison to `fifty_two_weeks_prior`, so dropping `prior_day`
    // would quietly measure labor against a different window than the sales
    // query and the metric labels, which keep the selected mode.
    fetchMock.mockResolvedValue(jsonResponse({}))

    const { getLaborOverview } = await import("../lib/backend/queries")
    await getLaborOverview("2026-08-03", "2026-08-09", "prior_day")

    const [url] = fetchMock.mock.calls[0]
    const request = new URL(String(url))
    expect(request.pathname).toBe("/internal/v1/labor-overview/")
    expect(request.searchParams.get("comparison")).toBe("prior_day")
  })

  it("round-trips a non-default comparison mode", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    const { getLaborOverview } = await import("../lib/backend/queries")
    await getLaborOverview("2026-08-03", "2026-08-09", "prior_year")

    const [url] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).searchParams.get("comparison")).toBe(
      "prior_year"
    )
  })

  it("falls back to the labor default when no comparison is passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    const { getLaborOverview } = await import("../lib/backend/queries")
    await getLaborOverview("2026-08-03", "2026-08-09")

    const [url] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).searchParams.get("comparison")).toBe(
      "fifty_two_weeks_prior"
    )
  })
})

describe("redirectOnInvalidPage", () => {
  it("sends a stale page back to the first, keeping the other controls", async () => {
    const { BackendRequestError, redirectOnInvalidPage } = await loadClient()
    const invalid = new BackendRequestError("Invalid page", 400)
    expect(() =>
      redirectOnInvalidPage(invalid, "/recipes", {
        page: 3,
        q: "flour",
        order: "-updatedAt",
        filters: { status: "all" },
      })
    ).toThrow("redirect:/recipes?q=flour&status=all")
    expect(() =>
      redirectOnInvalidPage(invalid, "/products", {
        page: 2,
        q: "",
        order: "-name",
        filters: { status: "active" },
      })
    ).toThrow("redirect:/products?order=-name&status=active")
  })

  it("rethrows everything that is not a page past the end", async () => {
    const { BackendRequestError, redirectOnInvalidPage } = await loadClient()
    const firstPage = new BackendRequestError("Invalid page", 400)
    expect(() =>
      redirectOnInvalidPage(firstPage, "/recipes", { page: 1 })
    ).toThrow(firstPage)
    const other = new BackendRequestError("Nope", 500)
    expect(() => redirectOnInvalidPage(other, "/recipes", { page: 3 })).toThrow(
      other
    )
    const plain = new Error("boom")
    expect(() => redirectOnInvalidPage(plain, "/recipes", { page: 3 })).toThrow(
      plain
    )
  })
})
