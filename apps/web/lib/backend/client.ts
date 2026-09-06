import "server-only"

import { headers } from "next/headers"
import type { ZodType } from "zod"

const backendOrigin =
  process.env.DJANGO_INTERNAL_ORIGIN ?? "http://127.0.0.1:8001"
const internalSecret =
  process.env.FORKLUCK_INTERNAL_SECRET ?? "dev-internal-secret"

/**
 * A stuck Django worker would otherwise hold a Next request open until the
 * reverse proxy or the Node process timeout intervenes, so every internal call
 * carries its own deadline.
 */
const requestTimeoutMs = Number(
  process.env.FORKLUCK_BACKEND_TIMEOUT_MS ?? 15_000
)

export class BackendUnauthorizedError extends Error {}

/** The backend did not answer within {@link requestTimeoutMs}. */
export class BackendTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`Forkluck backend did not respond within ${requestTimeoutMs}ms`)
    this.name = "BackendTimeoutError"
  }
}

export class BackendRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly editVersion?: number
  ) {
    super(message)
    this.name = "BackendRequestError"
  }
}

function reviveDates(key: string, value: unknown) {
  if (
    typeof value === "string" &&
    (key === "createdAt" ||
      key === "updatedAt" ||
      key === "effectiveAt" ||
      key === "undoneAt" ||
      key === "clockIn" ||
      key === "clockOut" ||
      key === "firstShiftAt" ||
      key === "lastShiftAt" ||
      key === "soldAt" ||
      key === "lastSoldAt" ||
      key === "lastMessageAt" ||
      key === "archivedAt")
  ) {
    return new Date(value)
  }
  return value
}

/** A pooled socket Gunicorn closed (at 2s idle) before Node did (at 4s). */
function isClosedConnection(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code
  return code === "UND_ERR_SOCKET" || code === "ECONNRESET"
}

/**
 * The one exchange with Django: timeout, retry and error handling.
 *
 * `cookie` is the browser session a request forwards, and "" for a system
 * call, which runs on a timer with no request behind it and so must never
 * reach for `headers()`.
 */
async function exchange<T>(
  path: string,
  init: RequestInit,
  cookie: string,
  system: boolean
): Promise<T> {
  const send = () =>
    fetch(new URL(path, backendOrigin), {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Forkluck-Internal-Secret": internalSecret,
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
    })
  let response: Response
  try {
    try {
      response = await send()
    } catch (error) {
      // Reads retry; a write cannot prove it never ran.
      if (init.method !== undefined || !isClosedConnection(error)) throw error
      response = await send()
    }
  } catch (error) {
    // AbortSignal.timeout aborts with TimeoutError; a caller-supplied signal
    // or a genuine network fault must stay distinguishable from it.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new BackendTimeoutError(path)
    }
    throw error
  }

  if (response.status === 401) {
    // A system route has no session to be signed out of, so a 401 from one
    // means the deployment is misconfigured, not that a user must log in.
    throw system
      ? new BackendRequestError(
          "Forkluck backend refused a system call: check the internal secret",
          401
        )
      : new BackendUnauthorizedError("Authentication required")
  }

  const text = await response.text()
  let payload = {} as T & {
    error?: string
    code?: string
    editVersion?: number
  }
  if (text) {
    try {
      payload = JSON.parse(text, reviveDates) as T & {
        error?: string
        code?: string
        editVersion?: number
      }
    } catch {
      if (response.ok)
        throw new Error("Forkluck backend returned an invalid response")
    }
  }
  if (!response.ok) {
    throw new BackendRequestError(
      payload.error ?? `Forkluck backend returned ${response.status}`,
      response.status,
      payload.code,
      payload.editVersion
    )
  }
  return payload
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const incoming = await headers()
  return exchange<T>(path, init, incoming.get("cookie") ?? "", false)
}

export function djangoGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

/**
 * A read that also checks the payload against its schema in development.
 *
 * The check is a drift alarm for the backend contract, not a parser: the
 * validated payload is discarded and the original object is returned, so the
 * value callers receive is byte-for-byte the same in every environment. In
 * production the check is skipped entirely and this is a plain `djangoGet`.
 */
export async function djangoGetParsed<T>(
  path: string,
  schema: ZodType<T>
): Promise<T> {
  const payload = await request<T>(path)
  if (process.env.NODE_ENV !== "production") schema.parse(payload)
  return payload
}

/**
 * A write to an internal route that is not an action — the action funnel
 * requires a signed-in user, and a few routes exist precisely for callers who
 * have no account yet.
 */
export function djangoPost<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export function djangoAction<T>(action: string, payload: unknown): Promise<T> {
  return request<T>(`/internal/v1/actions/${action}/`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

/**
 * A read the Next process makes as itself — the Drive watcher's timer, not a
 * browser request. Only the internal secret goes with it: there is no request
 * to take a cookie from, and Django's system routes never look for one.
 */
export function djangoSystemGet<T>(path: string): Promise<T> {
  return exchange<T>(path, {}, "", true)
}

/** The write half of the same surface. `path` is a full system route, because
 *  these are not action slugs. */
export function djangoSystemAction<T>(path: string, body: unknown): Promise<T> {
  return exchange<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    "",
    true
  )
}
