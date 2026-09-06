// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * The reviewer's one row of chrome: where in the pile this receipt is, and the
 * two ways it leaves. The arrows page from anywhere on the screen, because the
 * merchant's eyes are on the document, not on the buttons — but a typed arrow
 * belongs to the field being typed in.
 */

import { ReceiptPager } from "@/components/invoices/receipt-pager"

afterEach(cleanup)

function renderPager(props: Partial<Parameters<typeof ReceiptPager>[0]> = {}) {
  const onPrev = vi.fn()
  const onNext = vi.fn()
  render(
    <ReceiptPager
      title="Wegmans"
      subtitle="487155"
      position={3}
      count={40}
      filesCount={40}
      readingLabel={null}
      busy={false}
      blocker={null}
      importing={false}
      isDriveFile={false}
      onPrev={onPrev}
      onNext={onNext}
      onShowFiles={vi.fn()}
      onImport={vi.fn()}
      onSkip={vi.fn()}
      onNeverOffer={null}
      {...props}
    />
  )
  return { onPrev, onNext }
}

describe("ReceiptPager", () => {
  it("says which receipt this is and how many files are behind it", () => {
    renderPager()
    expect(screen.getByText("Wegmans")).toBeTruthy()
    expect(screen.getByText("487155")).toBeTruthy()
    expect(screen.getByText("3 of 40")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Files (40)" })).toBeTruthy()
  })

  it("stops at both ends of the list", () => {
    renderPager({ position: 1, count: 1 })
    expect(
      screen
        .getByRole("button", { name: "Previous receipt" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "Next receipt" })
        .hasAttribute("disabled")
    ).toBe(true)
  })

  it("pages on the arrow keys", () => {
    const { onPrev, onNext } = renderPager()
    fireEvent.keyDown(window, { key: "ArrowRight" })
    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it("pages from inside the dialog, which stops keys from bubbling out", () => {
    const { onNext } = renderPager()
    const panel = document.createElement("div")
    panel.addEventListener("keydown", (event) => event.stopPropagation())
    document.body.append(panel)

    fireEvent.keyDown(panel, { key: "ArrowRight" })

    expect(onNext).toHaveBeenCalledTimes(1)
    panel.remove()
  })

  it("leaves an arrow typed in a field to the field", () => {
    const { onPrev, onNext } = renderPager()
    const field = document.createElement("input")
    document.body.append(field)
    fireEvent.keyDown(field, { key: "ArrowRight" })
    fireEvent.keyDown(field, { key: "ArrowLeft" })
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
    field.remove()
  })

  it("leaves a held modifier to the browser", () => {
    const { onPrev, onNext } = renderPager()
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true })
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true })
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it("refuses Import while something on the receipt is missing", () => {
    renderPager({ blocker: "wegmans-487155.pdf needs a readable total." })
    expect(
      screen.getByText("wegmans-487155.pdf needs a readable total.")
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Import" }).hasAttribute("disabled")
    ).toBe(true)
  })

  it("offers to refuse a folder file for good, and only a folder file", () => {
    const onNeverOffer = vi.fn()
    const view = renderPager({ isDriveFile: true, onNeverOffer })
    expect(view).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Never offer this file" })
    )
    expect(onNeverOffer).toHaveBeenCalledTimes(1)

    cleanup()
    renderPager({ isDriveFile: false, onNeverOffer })
    expect(
      screen.queryByRole("button", { name: "Never offer this file" })
    ).toBeNull()
  })
})
