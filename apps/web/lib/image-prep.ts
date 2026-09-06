import "server-only"

import type { LineBox } from "@/lib/invoice-import"

/**
 * One place that turns a photographed receipt into what the model should see:
 * EXIF orientation applied (phones store sideways pixels plus a rotate tag,
 * and a sideways receipt reads worse), long edge capped at the vision tier's
 * limit so the request stays small, re-encoded as a high-quality JPEG.
 *
 * `width`/`height` are the prepared pixels — the ones the model reads. Because
 * the rotation is baked in here and a browser auto-rotates an `<img>` by the
 * same EXIF tag, a fraction of this image is a fraction of the photo the
 * reviewer sees, so a line's box needs no rotation math anywhere downstream.
 */

/** Long edge Claude Opus 5 / Sonnet 5 keep before downscaling themselves. */
export const IMAGE_MAX_EDGE = 2576

export type PreparedImage = {
  base64: string
  mediaType: "image/jpeg"
  bytes: number
  width: number
  height: number
}

/** A rectangle of an image, as fractions from the top-left corner. */
export type ImageRegion = { x0: number; y0: number; x1: number; y1: number }

/**
 * One receipt cut out of a photo of several. The fractions are of the PREPARED
 * image — the pixels the model was shown when it said there were three
 * receipts here — so the crop lands where the model pointed.
 */
export async function cropImage(
  prepared: Buffer,
  region: ImageRegion
): Promise<PreparedImage> {
  const { default: sharp } = await import("sharp")
  const image = sharp(prepared, { failOn: "error" })
  const { width = 0, height = 0 } = await image.metadata()
  const left = clampPixel(region.x0, width)
  const top = clampPixel(region.y0, height)
  const { data, info } = await image
    .extract({
      left,
      top,
      width: Math.max(
        1,
        Math.min(width - left, Math.round((region.x1 - region.x0) * width))
      ),
      height: Math.max(
        1,
        Math.min(height - top, Math.round((region.y1 - region.y0) * height))
      ),
    })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  return {
    base64: data.toString("base64"),
    mediaType: "image/jpeg",
    bytes: info.size,
    width: info.width,
    height: info.height,
  }
}

/** A fraction the model answered, as a pixel offset that is inside the image
 * and leaves at least one pixel to crop. */
function clampPixel(fraction: number, edge: number): number {
  return Math.min(
    Math.max(0, Math.round(fraction * edge)),
    Math.max(0, edge - 1)
  )
}

export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  // Loaded when a photo actually arrives, never at module load: sharp brings
  // a native binary, and a runtime without it must lose photo reading alone,
  // not every page whose actions can reach this file.
  const { default: sharp } = await import("sharp")
  const { data, info } = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({
      width: IMAGE_MAX_EDGE,
      height: IMAGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  return {
    base64: data.toString("base64"),
    mediaType: "image/jpeg",
    bytes: info.size,
    width: info.width,
    height: info.height,
  }
}

/** Text-row footprints inside a grounded receipt rectangle. */
async function receiptInkRows(input: Buffer, box: LineBox) {
  const { default: sharp } = await import("sharp")
  const image = sharp(input)
  const { width = 0, height = 0 } = await image.metadata()
  if (!width || !height) return null
  const left = clampPixel(box.x0, width)
  const top = clampPixel(box.y0, height)
  const cropWidth = Math.min(width, Math.ceil(box.x1 * width)) - left
  const cropHeight = Math.min(height, Math.ceil(box.y1 * height)) - top
  if (cropWidth < 20 || cropHeight < 8) return null
  const { data } = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .flatten({ background: "#fff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  // Ignore isolated noise and bridge a one-pixel gap within a printed glyph.
  const bands = (startX: number) => {
    const rows: Array<{ start: number; end: number }> = []
    const minimumInk = Math.max(2, Math.ceil((cropWidth - startX) * 0.01))
    for (let y = 0; y < cropHeight; y += 1) {
      let ink = 0
      for (let x = startX; x < cropWidth; x += 1) {
        if (data[y * cropWidth + x] < 128) ink += 1
      }
      if (ink < minimumInk) continue
      const previous = rows.at(-1)
      if (previous && y - previous.end <= 2) previous.end = y
      else rows.push({ start: y, end: y })
    }
    return rows.filter((row) => row.end - row.start >= 3)
  }
  const text = bands(0)
  const amounts = bands(Math.floor(cropWidth * 0.75))
  return { text, amounts, top, height }
}

/** Split a two-row receipt box only when its amount column has ink on the
 * first row alone. The caller has already proved that the second row's
 * quantity belongs to the next item. Ambiguous pixels leave the box alone. */
export async function receiptPrefixBoundary(
  input: Buffer,
  box: LineBox
): Promise<number | null> {
  const rows = await receiptInkRows(input, box)
  if (!rows) return null
  const { text, amounts, top, height } = rows
  if (text.length !== 2 || amounts.length !== 1) return null
  const [item, prefix] = text
  const [amount] = amounts
  const itemEnd = Math.max(item.end, amount.end)
  if (
    amount.end < item.start ||
    amount.start > item.end ||
    prefix.start - itemEnd < 3
  )
    return null
  // Only the prefix's start defines this gap. The next item's model box can
  // start inside the prefix and clip its bottom without obscuring the gap.
  return (top + (itemEnd + prefix.start) / 2) / height
}

/** A one-item rectangle can also run into the following item's amount row.
 * Two distinct amount/text rows identify the blank gap where it must stop. */
export async function receiptItemBottomBoundary(
  input: Buffer,
  box: LineBox
): Promise<number | null> {
  const rows = await receiptInkRows(input, box)
  if (!rows) return null
  const { text, amounts, top, height } = rows
  if (amounts.length < 2) return null
  const itemIndex = text.findIndex(
    (row) => amounts[0].end >= row.start && amounts[0].start <= row.end
  )
  const item = text[itemIndex]
  const next = text[itemIndex + 1]
  if (
    !item ||
    !next ||
    amounts[1].end < next.start ||
    amounts[1].start > next.end
  )
    return null
  const itemEnd = Math.max(item.end, amounts[0].end)
  const nextStart = Math.min(next.start, amounts[1].start)
  if (nextStart - itemEnd < 3) return null
  return (top + (itemEnd + nextStart) / 2) / height
}
