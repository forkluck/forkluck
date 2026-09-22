import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * What `deleteAccount` puts on the wire and how it reports failure. It
 * revalidates nothing on purpose: the caller leaves through /logout and every
 * page of the workspace is gone with the account. The backend tests cover
 * the deletion itself.
 */

const sent: { slug: string; body: Record<string, unknown> }[] = []
const revalidated: string[] = []
let rejection: unknown = null

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path)
  },
}))
vi.mock("@/lib/auth-session", () => ({
  requireUser: () => Promise.resolve({}),
}))
vi.mock("@/lib/backend/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  djangoAction: (slug: string, body: Record<string, unknown>) => {
    sent.push({ slug, body })
    return rejection ? Promise.reject(rejection) : Promise.resolve({ ok: true })
  },
}))

const { deleteAccount } = await import("@/app/(app)/profile/actions")

describe("deleteAccount", () => {
  beforeEach(() => {
    sent.length = 0
    revalidated.length = 0
    rejection = null
  })

  it("posts an empty body and revalidates nothing", async () => {
    expect(await deleteAccount()).toEqual({ ok: true })
    expect(sent).toEqual([{ slug: "delete-account", body: {} }])
    expect(revalidated).toEqual([])
  })

  it("reports a failure instead of throwing", async () => {
    rejection = { status: 503 }

    expect(await deleteAccount()).toEqual({
      error: "Couldn’t delete your account.",
    })
  })
})
