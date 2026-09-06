import { describe, expect, it } from "vitest"

import {
  DRIVE_MAX_IMAGE_BYTES,
  DRIVE_MAX_PDF_BYTES,
  driveFileSupport,
  parseDriveFolderId,
  type DriveFile,
} from "@/lib/drive-folder"

function file(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "file-1",
    name: "IV101-123.pdf",
    mimeType: "application/pdf",
    sizeBytes: 150_000,
    webViewLink: "https://drive.google.com/file/d/file-1/view",
    ...overrides,
  }
}

describe("parseDriveFolderId", () => {
  it("reads the three shapes a folder link arrives in", () => {
    expect(
      parseDriveFolderId(
        "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345?usp=sharing"
      )
    ).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz012345")
    expect(
      parseDriveFolderId(
        "https://drive.google.com/drive/u/0/folders/abc_123-XY"
      )
    ).toBe("abc_123-XY")
    expect(
      parseDriveFolderId("https://drive.google.com/open?id=1V4O-H0Ea9SQd22")
    ).toBe("1V4O-H0Ea9SQd22")
    expect(parseDriveFolderId("  1V4O-H0Ea9SQd22  ")).toBe("1V4O-H0Ea9SQd22")
  })

  it("refuses anything that isn't a folder id", () => {
    expect(parseDriveFolderId("")).toBeNull()
    expect(parseDriveFolderId("kitchen receipts")).toBeNull()
    expect(parseDriveFolderId("short")).toBeNull()
    // A file link is not a folder link, and its id must not be salvaged.
    expect(
      parseDriveFolderId("https://drive.google.com/file/d/1V4O-H0Ea9SQd22/view")
    ).toBeNull()
  })
})

describe("driveFileSupport", () => {
  it("accepts PDFs and photos inside their own cap", () => {
    expect(driveFileSupport(file())).toBe("ok")
    expect(
      driveFileSupport(
        file({ mimeType: "image/jpeg", sizeBytes: DRIVE_MAX_IMAGE_BYTES })
      )
    ).toBe("ok")
    // Drive reports no size for a Google-native document; nothing to refuse on.
    expect(driveFileSupport(file({ sizeBytes: null }))).toBe("ok")
  })

  it("applies the PDF cap to PDFs and the image cap to images", () => {
    expect(driveFileSupport(file({ sizeBytes: DRIVE_MAX_PDF_BYTES + 1 }))).toBe(
      "too_large"
    )
    // The same byte count is fine for a photo.
    expect(
      driveFileSupport(
        file({ mimeType: "image/png", sizeBytes: DRIVE_MAX_PDF_BYTES + 1 })
      )
    ).toBe("ok")
    expect(
      driveFileSupport(
        file({ mimeType: "image/png", sizeBytes: DRIVE_MAX_IMAGE_BYTES + 1 })
      )
    ).toBe("too_large")
  })

  it("calls HEIC out separately from other unsupported types", () => {
    expect(driveFileSupport(file({ mimeType: "image/heic" }))).toBe("heic")
    expect(
      driveFileSupport(file({ mimeType: "", name: "IMG_1584.HEIC" }))
    ).toBe("heic")
    expect(
      driveFileSupport(
        file({ mimeType: "application/vnd.google-apps.spreadsheet" })
      )
    ).toBe("unsupported")
  })
})
