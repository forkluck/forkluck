// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { DropZone } from "@/components/ui/drop-zone"

afterEach(cleanup)

function fileList(files: File[]) {
  return { files, types: ["Files"] }
}

describe("DropZone", () => {
  it("hands over the files a drop carries", () => {
    const onFiles = vi.fn()
    render(<DropZone onFiles={onFiles} />)
    const zone = screen.getByRole("button", { name: /Drop files here/ })
    const file = new File(["invoice"], "invoice.pdf", {
      type: "application/pdf",
    })

    fireEvent.drop(zone, { dataTransfer: fileList([file]) })

    expect(onFiles).toHaveBeenCalledOnce()
    expect(onFiles.mock.calls[0][0]).toEqual([file])
  })

  it("hands over the files the picker returned", () => {
    const onFiles = vi.fn()
    const { container } = render(<DropZone onFiles={onFiles} />)
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(["invoice"], "invoice.pdf", {
      type: "application/pdf",
    })

    fireEvent.change(input, { target: { files: [file] } })

    expect(onFiles).toHaveBeenCalledOnce()
    expect(onFiles.mock.calls[0][0]).toEqual([file])
  })

  it("marks the drag only while files are over it", () => {
    render(<DropZone onFiles={vi.fn()} />)
    const zone = screen.getByRole("button", { name: /Drop files here/ })

    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"] } })
    expect(zone.getAttribute("data-dragging")).toBe("true")

    fireEvent.dragLeave(zone, { dataTransfer: { types: ["Files"] } })
    expect(zone.hasAttribute("data-dragging")).toBe(false)
  })

  it("leaves a drag that carries no files to the page", () => {
    const onFiles = vi.fn()
    render(<DropZone onFiles={onFiles} />)
    const zone = screen.getByRole("button", { name: /Drop files here/ })

    fireEvent.dragEnter(zone, { dataTransfer: { types: ["text/plain"] } })
    expect(zone.hasAttribute("data-dragging")).toBe(false)

    fireEvent.drop(zone, {
      dataTransfer: { types: ["text/plain"], files: [] },
    })
    expect(onFiles).not.toHaveBeenCalled()
  })

  it("opens the picker from the keyboard", () => {
    const { container } = render(<DropZone onFiles={vi.fn()} />)
    const zone = screen.getByRole("button", { name: /Drop files here/ })
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, "click")

    fireEvent.keyDown(zone, { key: "Enter" })
    expect(click).toHaveBeenCalledOnce()

    fireEvent.keyDown(zone, { key: " " })
    expect(click).toHaveBeenCalledTimes(2)
  })

  it("stays shut when it is disabled", () => {
    const onFiles = vi.fn()
    render(<DropZone disabled onFiles={onFiles} />)
    const zone = screen.getByRole("button", { name: /Drop files here/ })
    const file = new File(["invoice"], "invoice.pdf", {
      type: "application/pdf",
    })

    fireEvent.drop(zone, { dataTransfer: fileList([file]) })

    expect(onFiles).not.toHaveBeenCalled()
    expect(zone.getAttribute("aria-disabled")).toBe("true")
  })
})
