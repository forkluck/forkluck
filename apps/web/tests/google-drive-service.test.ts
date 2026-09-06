import { generateKeyPairSync } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// A real key, because the client signs a JWT with it before any Drive call.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = Buffer.from(
  JSON.stringify({
    client_email: "receipts@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  })
).toString("base64")

import {
  DriveCursorExpiredError,
  DriveServiceError,
  getStartPageToken,
  listDriveChanges,
} from "@/lib/google-drive-service"

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Google, as far as the client can tell: the token exchange always succeeds
 * and every Drive request goes to `answer`. Returns the Drive URLs seen. */
function stubGoogle(answer: (url: URL) => Response): URL[] {
  const seen: URL[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.origin === "https://oauth2.googleapis.com") {
        return json(200, { access_token: "token", expires_in: 3600 })
      }
      seen.push(url)
      return answer(url)
    })
  )
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// What Google actually answers, verified against the live API: the listing
// endpoint demands a cursor, and only its sibling hands out a first one.
const LISTING_WITHOUT_CURSOR = {
  error: { code: 400, message: "Required parameter: pageToken" },
}

describe("getStartPageToken", () => {
  it("asks the startPageToken endpoint, never the listing", async () => {
    const seen = stubGoogle((url) =>
      url.pathname === "/drive/v3/changes/startPageToken"
        ? json(200, {
            kind: "drive#startPageToken",
            startPageToken: "cursor-1",
          })
        : json(400, LISTING_WITHOUT_CURSOR)
    )

    await expect(getStartPageToken()).resolves.toBe("cursor-1")

    expect(seen.map((url) => url.pathname)).toEqual([
      "/drive/v3/changes/startPageToken",
    ])
    expect(seen[0].searchParams.get("supportsAllDrives")).toBe("true")
  })

  it("reports a refused request as a Drive failure, not a dropped cursor", async () => {
    stubGoogle(() => json(400, LISTING_WITHOUT_CURSOR))

    const failure = getStartPageToken()
    await expect(failure).rejects.toBeInstanceOf(DriveServiceError)
    await expect(failure).rejects.not.toBeInstanceOf(DriveCursorExpiredError)
    await expect(failure).rejects.toThrow("Google Drive failed (400).")
  })

  it("refuses an answer without a cursor in it", async () => {
    stubGoogle(() => json(200, { kind: "drive#startPageToken" }))

    await expect(getStartPageToken()).rejects.toThrow(
      "Google Drive returned no change cursor."
    )
  })
})

describe("listDriveChanges", () => {
  it("polls the listing with the cursor it was given", async () => {
    const seen = stubGoogle(() =>
      json(200, { changes: [], newStartPageToken: "cursor-2" })
    )

    await expect(listDriveChanges("cursor-1")).resolves.toEqual({
      changes: [],
      newStartPageToken: "cursor-2",
    })

    expect(seen.map((url) => url.pathname)).toEqual(["/drive/v3/changes"])
    expect(seen[0].searchParams.get("pageToken")).toBe("cursor-1")
  })

  it("tells a cursor Google no longer keeps apart from other failures", async () => {
    stubGoogle(() => new Response("", { status: 410 }))
    await expect(listDriveChanges("old")).rejects.toBeInstanceOf(
      DriveCursorExpiredError
    )

    stubGoogle(() =>
      json(400, { error: { message: "Invalid Value", location: "pageToken" } })
    )
    await expect(listDriveChanges("bogus")).rejects.toBeInstanceOf(
      DriveCursorExpiredError
    )

    stubGoogle(() => new Response("", { status: 500 }))
    const failure = listDriveChanges("cursor-1")
    await expect(failure).rejects.toBeInstanceOf(DriveServiceError)
    await expect(failure).rejects.not.toBeInstanceOf(DriveCursorExpiredError)
  })
})
