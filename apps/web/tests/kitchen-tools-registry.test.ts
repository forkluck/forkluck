import { describe, expect, it } from "vitest"

import {
  KITCHEN_TOOLS,
  KITCHEN_TOOL_NAMES,
  kitchenToolDescriptors,
} from "@/lib/primo/kitchen-tools"

function schemaDescriptions(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  return [
    ...(typeof row.description === "string" ? [row.description] : []),
    ...Object.values(row).flatMap(schemaDescriptions),
  ]
}

function expectPlainEnumerable(value: unknown): void {
  if (!value || typeof value !== "object") return
  expect([Object.prototype, Array.prototype]).toContain(
    Object.getPrototypeOf(value)
  )
  for (const name of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && name === "length") continue
    expect(Object.getOwnPropertyDescriptor(value, name)?.enumerable).toBe(true)
    expectPlainEnumerable((value as Record<string, unknown>)[name])
  }
}

describe("kitchen tool registry", () => {
  it("declares exactly five compact read-only tools", () => {
    expect(KITCHEN_TOOL_NAMES).toEqual([
      "find_recipes",
      "find_products",
      "get_product_sales",
      "show_recipe_batch",
      "get_recipe_cost_change",
    ])
    for (const name of KITCHEN_TOOL_NAMES) {
      expect(name.length).toBeLessThanOrEqual(30)
      expect(KITCHEN_TOOLS[name].description.length).toBeLessThanOrEqual(500)
      expect(KITCHEN_TOOLS[name].annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true,
      })
    }
  })

  it("emits strict, compact, JSON-serializable descriptors", () => {
    const descriptors = kitchenToolDescriptors()
    expect(descriptors).toHaveLength(5)
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema.additionalProperties).toBe(false)
      for (const description of schemaDescriptions(descriptor.inputSchema)) {
        expect(description.length).toBeLessThanOrEqual(150)
      }
    }
    expect(() => JSON.stringify(descriptors)).not.toThrow()
    expectPlainEnumerable(descriptors)
  })
})
