import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * An action sends an expired session to /login one of two ways: through
 * actionErrorMessage in a catch, or through requireUser() before the call.
 * One or the other. With neither, the user is left on a dead screen.
 */
const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
)

function actionFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...actionFiles(full))
      continue
    }
    if (entry === "actions.ts") found.push(full)
  }
  return found
}

type ServerAction = { file: string; name: string; body: string }

function serverActions(): ServerAction[] {
  return actionFiles(path.join(repositoryRoot, "app")).flatMap((file) => {
    const source = readFileSync(file, "utf8")
    if (!source.startsWith('"use server"')) return []
    return source
      .split(/\nexport async function /)
      .slice(1)
      .map((chunk) => ({
        file: path.relative(repositoryRoot, file),
        name: chunk.slice(0, chunk.indexOf("(")),
        body: chunk,
      }))
  })
}

function returnsFailures(action: ServerAction): boolean {
  return (
    /catch \(/.test(action.body) && action.body.includes("actionErrorMessage")
  )
}

function guardsUpFront(action: ServerAction): boolean {
  return action.body.includes("await requireUser()")
}

describe("every server action can redirect an expired session", () => {
  it("finds the actions it is meant to scan", () => {
    const actions = serverActions()
    expect(actions.length).toBeGreaterThan(50)
    expect(new Set(actions.map((action) => action.file)).size).toBeGreaterThan(
      5
    )
  })

  it("takes one of the two shapes, never neither", () => {
    const offenders = serverActions()
      .filter((action) => !returnsFailures(action) && !guardsUpFront(action))
      .map((action) => `${action.file}: ${action.name}`)

    expect(offenders).toEqual([])
  })

  it("still has actions of both shapes", () => {
    const actions = serverActions()
    expect(actions.filter(returnsFailures).length).toBeGreaterThan(0)
    expect(
      actions.filter(
        (action) => !returnsFailures(action) && guardsUpFront(action)
      ).length
    ).toBeGreaterThan(0)
  })
})
