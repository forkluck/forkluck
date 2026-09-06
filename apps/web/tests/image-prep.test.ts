import sharp from "sharp"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  IMAGE_MAX_EDGE,
  cropImage,
  prepareImage,
  receiptItemBottomBoundary,
  receiptPrefixBoundary,
} from "@/lib/image-prep"

/** A wide image tagged "rotate 90° clockwise", the way a phone stores a
 * portrait receipt photo taken in landscape orientation. */
async function sidewaysJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
}

describe("prepareImage", () => {
  it("applies the EXIF rotation and caps the long edge", async () => {
    const prepared = await prepareImage(await sidewaysJpeg(3600, 1200))
    expect(prepared.mediaType).toBe("image/jpeg")
    // Rotated upright: the 3600px side becomes the height, then shrinks to the cap.
    expect(prepared.height).toBe(IMAGE_MAX_EDGE)
    expect(prepared.width).toBe(Math.round((1200 * IMAGE_MAX_EDGE) / 3600))
    expect(prepared.bytes).toBeGreaterThan(0)
    expect(Buffer.from(prepared.base64, "base64")).toHaveLength(prepared.bytes)
    // The rotation tag is consumed, not carried into the output.
    expect(
      (await sharp(Buffer.from(prepared.base64, "base64")).metadata())
        .orientation
    ).toBeUndefined()
  })

  it("leaves a small upright image at its own size", async () => {
    const small = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer()
    const prepared = await prepareImage(small)
    expect([prepared.width, prepared.height]).toEqual([640, 480])
    expect(prepared.mediaType).toBe("image/jpeg")
  })

  it("rejects bytes that are not an image", async () => {
    await expect(
      prepareImage(Buffer.from("%PDF-1.4 not an image"))
    ).rejects.toThrow()
  })
})

describe("cropImage", () => {
  async function photo(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: "#fff" },
    })
      .jpeg()
      .toBuffer()
  }

  it("cuts the region the model pointed at out of the prepared photo", async () => {
    // The right-hand receipt of two photographed side by side.
    const crop = await cropImage(await photo(1000, 800), {
      x0: 0.5,
      y0: 0.25,
      x1: 1,
      y1: 0.75,
    })
    expect([crop.width, crop.height]).toEqual([500, 400])
    expect(crop.mediaType).toBe("image/jpeg")
    expect(Buffer.from(crop.base64, "base64")).toHaveLength(crop.bytes)
  })

  it("keeps a region that runs off the edge inside the image", async () => {
    // A model that answers 1.2 must not make sharp throw; the crop stops at
    // the edge instead.
    const crop = await cropImage(await photo(1000, 800), {
      x0: 0.9,
      y0: 0.9,
      x1: 1.2,
      y1: 1.4,
    })
    expect([crop.width, crop.height]).toEqual([100, 80])
  })
})

describe("receiptPrefixBoundary", () => {
  const box = { page: 0, x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.3 }

  async function receipt(scenario = "prefix", scale = 1) {
    // Synthetic text footprints: description and amount on one row, a short
    // quantity prefix below. No production receipt pixels or prices.
    const rows = [
      '<rect x="250" y="215" width="300" height="15"/>',
      ...(scenario === "no amount"
        ? []
        : ['<rect x="760" y="215" width="90" height="15"/>']),
      ...(scenario === "one row"
        ? []
        : ['<rect x="120" y="260" width="180" height="15"/>']),
      ...(scenario === "two amounts"
        ? ['<rect x="760" y="260" width="90" height="15"/>']
        : []),
      ...(scenario === "thin amount edges"
        ? [
            '<rect x="760" y="213" width="4" height="19"/>',
            '<rect x="760" y="260" width="90" height="15"/>',
          ]
        : []),
      ...(scenario === "third row"
        ? ['<rect x="250" y="240" width="90" height="10"/>']
        : []),
      '<rect x="800" y="240" width="1" height="1"/>',
    ]
    return sharp(
      Buffer.from(
        `<svg width="1000" height="1000"><rect width="1000" height="1000" fill="white"/>${rows.join("")}</svg>`
      )
    )
      .resize(1000 * scale)
      .png()
      .toBuffer()
  }

  it.each([0.5, 1, 2])("finds the blank gap at scale %s", async (scale) => {
    const boundary = await receiptPrefixBoundary(
      await receipt("prefix", scale),
      box
    )
    expect(boundary).toBeGreaterThan(0.23)
    expect(boundary).toBeLessThan(0.26)
  })

  it.each(["no amount", "two amounts", "one row", "third row"])(
    "refuses ambiguous pixels: %s",
    async (scenario) => {
      expect(
        await receiptPrefixBoundary(await receipt(scenario), box)
      ).toBeNull()
    }
  )

  it.each([0.264, 0.27, 0.275, 0.3])(
    "keeps the same gap when the prefix crop ends at %s",
    async (y1) => {
      const pixels = await receipt()
      expect(await receiptPrefixBoundary(pixels, { ...box, y1 })).toBe(
        await receiptPrefixBoundary(pixels, box)
      )
    }
  )

  it("refuses a crop that ends before any prefix text is visible", async () => {
    expect(
      await receiptPrefixBoundary(await receipt(), { ...box, y1: 0.26 })
    ).toBeNull()
  })

  it.each(["two amounts", "thin amount edges"])(
    "stops before the next item with %s",
    async (scenario) => {
      const boundary = await receiptItemBottomBoundary(
        await receipt(scenario),
        box
      )
      expect(boundary).toBeGreaterThan(0.232)
      expect(boundary).toBeLessThan(0.26)
    }
  )

  it.each(["prefix", "no amount", "one row"])(
    "does not mistake %s for a following item",
    async (scenario) => {
      expect(
        await receiptItemBottomBoundary(await receipt(scenario), box)
      ).toBeNull()
    }
  )
})
