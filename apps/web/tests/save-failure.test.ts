import { describe, expect, it } from "vitest"

import {
  DEPLOY_SKEW_MESSAGE,
  isDeploySkew,
  toSaveFailure,
} from "@/lib/save-failure"

describe("toSaveFailure", () => {
  it("reads an action's error string as a request failure", () => {
    expect(toSaveFailure({ error: "Backend is down" })).toEqual({
      kind: "request",
      message: "Backend is down",
    })
  })

  it("reads a thrown error as a request failure", () => {
    expect(toSaveFailure(new Error("Flour is not linked"))).toEqual({
      kind: "request",
      message: "Flour is not linked",
    })
  })

  it("rewrites the deploy-skew message Next throws, with or without an id", () => {
    const named = toSaveFailure(
      new Error(
        'Failed to find Server Action "7f3a9c". This request might be from an older or newer deployment.'
      )
    )
    const bare = toSaveFailure({
      error:
        "Failed to find the Server Action. This request might be from an older or newer deployment.",
    })
    expect(named.message).toMatch(/A new version was deployed/)
    expect(bare.message).toBe(named.message)
    expect(named.kind).toBe("request")
  })

  it("rewrites the UnrecognizedActionError a live deploy skew throws", () => {
    // What Next 16 actually raises: its own class, and this message.
    const thrown = new Error(
      'Server Action "40424fb5e7" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action'
    )
    thrown.name = "UnrecognizedActionError"

    expect(isDeploySkew(thrown)).toBe(true)
    expect(toSaveFailure(thrown).message).toBe(DEPLOY_SKEW_MESSAGE)
    // Either half stands on its own, so a bundler that drops the name
    // does not lose the case.
    expect(isDeploySkew(new Error(thrown.message))).toBe(true)
    expect(isDeploySkew(new Error("Backend is down"))).toBe(false)
  })

  it("reads a refused stale write as a conflict, with the server's version", () => {
    expect(
      toSaveFailure({
        error:
          "This recipe changed in another window. Reload to see the latest.",
        code: "stale_write",
        editVersion: 7,
      })
    ).toEqual({
      kind: "conflict",
      message:
        "This recipe changed in another window. Reload to see the latest.",
      version: 7,
    })
  })

  it("says something rather than nothing when the failure carries no message", () => {
    expect(toSaveFailure(new Error(""))).toEqual({
      kind: "request",
      message: "The change was not saved. Try again.",
    })
    expect(toSaveFailure(undefined).kind).toBe("request")
  })
})
