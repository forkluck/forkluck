import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

/**
 * The backend client revives certain JSON keys into `Date`s by name, for every
 * internal response. That pin is mechanical on the client side and hand-written
 * in `types.ts`, and it failed quietly: `lastSoldAt` was declared
 * `string | null` on the ignored-identity type while arriving as a `Date`, so
 * the "Last sold" column sorted alphabetically by weekday name.
 *
 * Reading both files as text is deliberate — importing the client would drag in
 * `next/headers`, and the defect being guarded is a *declaration* mismatch that
 * no runtime value can expose.
 */
function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function revivedKeys(): string[] {
  const source = read("../lib/backend/client.ts")
  const body = source.slice(
    source.indexOf("function reviveDates"),
    source.indexOf("async function request")
  )
  const keys = [...body.matchAll(/key === "(\w+)"/g)].map((match) => match[1])
  return keys
}

describe("the date reviver allowlist and types.ts agree", () => {
  it("finds the allowlist", () => {
    expect(revivedKeys().length).toBeGreaterThan(5)
  })

  it("declares no revived key as a string", () => {
    const types = read("../lib/backend/types.ts")
    const offenders = revivedKeys().flatMap((key) => {
      const pattern = new RegExp(`^\\s*${key}\\??:\\s*(.+)$`, "gm")
      return [...types.matchAll(pattern)]
        .map((match) => match[1].trim())
        .filter((declared) => /\bstring\b/.test(declared))
        .map((declared) => `${key}: ${declared}`)
    })

    expect(offenders).toEqual([])
  })
})
