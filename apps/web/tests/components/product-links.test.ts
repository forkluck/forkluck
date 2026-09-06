import { describe, expect, it } from "vitest"

import { productHref, productPublicId } from "@/lib/product-href"

describe("Product browser links", () => {
  it("use the required public identity rather than the internal UUID", () => {
    const product = {
      id: "22222222-2222-2222-2222-222222222222",
      publicId: "prd_000000000001",
    }

    expect(productPublicId(product)).toBe("prd_000000000001")
    expect(productHref(product)).toBe("/products/prd_000000000001")
  })
})
