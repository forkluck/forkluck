import { describe, expect, it } from "vitest"

import { resolveComposerKey } from "@/lib/primo/composer-keys"

describe("resolveComposerKey", () => {
  const closed = { pickerOpen: false, hasPickerOptions: false }

  it.each([
    [{ key: "Enter" }, closed, "send"],
    [{ key: "Enter", shiftKey: true }, closed, "newline"],
    [{ key: "Enter", isComposing: true }, closed, "none"],
    [{ key: "Enter", keyCode: 229 }, closed, "none"],
    [{ key: "Enter" }, { pickerOpen: true, hasPickerOptions: true }, "pick"],
    [{ key: "Escape" }, { pickerOpen: true, hasPickerOptions: false }, "close"],
    [{ key: "a" }, closed, "none"],
  ] as const)("maps %o to %s", (event, state, expected) => {
    expect(resolveComposerKey(event, state)).toBe(expected)
  })
})
