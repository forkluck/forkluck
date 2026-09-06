import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The type scale is ten `--text-*` steps in app/globals.css and nothing
 * between them (AGENTS.md "Type scale"). Tailwind's own sizes are cleared
 * there, so a size off the ladder would not fail the build: an unknown name
 * renders at the browser default and an arbitrary pixel value reopens the
 * drift this pins shut. Both are caught here instead.
 */
const STEPS = ["2xs", "xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl"]

/** The Nutrition Facts label imitates a regulated format on its own sizes. */
const EXEMPT = new Set(["components/nutrition/nutrition-label.tsx"])

const ARBITRARY = /(?<![\w-])text-\[[0-9.]+(px|rem|em)\]/
const UNKNOWN_STEP = /(?<![\w-])text-(5xl|6xl|7xl|8xl|9xl)(?![\w-])/

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe("type scale", () => {
  it("declares exactly the ten steps and clears Tailwind's", () => {
    const css = readFileSync("app/globals.css", "utf8")
    const declared = [...css.matchAll(/^\s*--text-([0-9a-z]+):/gm)].map(
      (match) => match[1]
    )
    expect(declared).toEqual(STEPS)
    expect(css).toContain("--text-*: initial;")
  })

  it("is the only source of a font size in app/ and components/", () => {
    const offenders: string[] = []
    for (const file of [...tsxFiles("app"), ...tsxFiles("components")]) {
      if (EXEMPT.has(file)) continue
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (ARBITRARY.test(line) || UNKNOWN_STEP.test(line)) {
            offenders.push(`${file}:${index + 1}`)
          }
        })
    }
    expect(
      offenders,
      'font sizes off the ladder; pick a step from AGENTS.md "Type scale"'
    ).toEqual([])
  })
})
