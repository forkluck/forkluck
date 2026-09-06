// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/business-settings-provider", () => ({
  useBusinessSettings: () => ({ measurementSystem: "imperial" }),
}))

import { PreparationDialog } from "@/components/ingredients/preparation-dialog"
import type { SaveFailure } from "@/lib/save-failure"

afterEach(cleanup)

describe("PreparationDialog", () => {
  it("starts blank and uses the ingredient conversion", async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(<PreparationDialog open onOpenChange={vi.fn()} onAdd={onAdd} />)

    expect(screen.getByLabelText("Name (required)")).not.toBeNull()
    expect(
      (screen.getByLabelText("Yield percent") as HTMLInputElement).value
    ).toBe("")
    expect(screen.getByLabelText("Weight amount")).not.toBeNull()
    expect(screen.getByLabelText("Volume amount")).not.toBeNull()
    expect(screen.getByLabelText("Each amount")).not.toBeNull()

    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).value
    ).toBe("")
    expect(
      (screen.getByLabelText("Volume amount") as HTMLInputElement).value
    ).toBe("")
    expect(
      (screen.getByLabelText("Each amount") as HTMLInputElement).value
    ).toBe("")
    expect(
      screen.getByLabelText("Each amount").getAttribute("placeholder")
    ).toBe("–")
    const standard = screen.getByRole("switch", {
      name: "Use ingredient's standard conversion",
    })
    expect(standard.getAttribute("data-checked")).not.toBeNull()
    expect(
      screen.getByLabelText("Weight amount").hasAttribute("disabled")
    ).toBe(true)
    expect(screen.getByText(/Leave yield blank/)).not.toBeNull()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Diced" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add preparation" }))
    })
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Diced",
        yieldPercent: null,
        usesStandardConversion: true,
        weight: null,
        volume: null,
        each: null,
      })
    )
  })

  it("rejects an amount without its unit", async () => {
    const onAdd = vi.fn()
    render(<PreparationDialog open onOpenChange={vi.fn()} onAdd={onAdd} />)
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Use ingredient's standard conversion",
      })
    )
    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Diced" },
    })
    fireEvent.change(screen.getByLabelText("Weight amount"), {
      target: { value: "100" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add preparation" }))
    })
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Weight amount and unit must be supplied together"
    )
  })
})

/** A dialog on a preparation that already exists, so nothing is dirty yet. */
const DICED = {
  id: "prep-1",
  name: "Diced",
  yieldPercent: 90,
  usesStandardConversion: false,
  weight: { amount: 237, unit: "g" },
  volume: { amount: 1, unit: "cup" },
  each: null,
}

const STANDARD = {
  id: "prep-standard",
  name: "Cooked",
  yieldPercent: null,
  usesStandardConversion: true,
  weight: null,
  volume: null,
  each: null,
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Name (required)"), {
    target: { value },
  })
}

function submit() {
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save preparation" }))
  })
}

describe("a preparation that has to reach the server", () => {
  it("preserves a standard row and its blank values on a name-only edit", async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(
      <PreparationDialog
        open
        initial={STANDARD}
        onOpenChange={vi.fn()}
        onAdd={onAdd}
      />
    )

    type("Cooked and cooled")
    await submit()

    expect(onAdd).toHaveBeenCalledWith({
      ...STANDARD,
      name: "Cooked and cooled",
    })
  })

  it("clears custom pairs when switched back to standard", async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={vi.fn()}
        onAdd={onAdd}
      />
    )

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Use ingredient's standard conversion",
      })
    )
    expect(
      (screen.getByLabelText("Weight amount") as HTMLInputElement).value
    ).toBe("")
    type("Fine dice")
    await submit()

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        usesStandardConversion: true,
        weight: null,
        volume: null,
        each: null,
      })
    )
  })

  it("closes only once the save landed", async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={onOpenChange}
        onAdd={onAdd}
      />
    )

    type("Small dice")
    await submit()

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open and says why when the save did not land", async () => {
    const onAdd = vi
      .fn()
      .mockResolvedValue({ kind: "request", message: "Backend is down" })
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={onOpenChange}
        onAdd={onAdd}
      />
    )

    type("Small dice")
    await submit()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Backend is down")
    expect(
      (screen.getByLabelText("Name (required)") as HTMLInputElement).value
    ).toBe("Small dice")
  })

  it("takes one request from two presses", async () => {
    let finish: ((result: SaveFailure | null) => void) | null = null
    const onAdd = vi.fn(
      () =>
        new Promise<SaveFailure | null>((resolve) => {
          finish = resolve
        })
    )
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={vi.fn()}
        onAdd={onAdd}
      />
    )

    type("Small dice")
    fireEvent.click(screen.getByRole("button", { name: "Save preparation" }))
    fireEvent.click(screen.getByRole("button", { name: "Save preparation" }))

    expect(onAdd).toHaveBeenCalledTimes(1)
    await act(async () => finish!(null))
  })

  it("sends nothing when nothing was touched", async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={onOpenChange}
        onAdd={onAdd}
      />
    )

    await submit()

    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("closing a preparation dialog", () => {
  it("asks before dropping edits, whichever way it is dismissed", () => {
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
      />
    )

    type("Small dice")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByText("Discard changes?")).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes a pristine new preparation without asking", () => {
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog open onOpenChange={onOpenChange} onAdd={vi.fn()} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("still asks a new preparation for a name rather than closing it", async () => {
    const onAdd = vi.fn()
    const onOpenChange = vi.fn()
    render(<PreparationDialog open onOpenChange={onOpenChange} onAdd={onAdd} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add preparation" }))
    })

    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter a name.")
  })

  it("closes an untouched dialog without asking", () => {
    const onOpenChange = vi.fn()
    render(
      <PreparationDialog
        open
        initial={DICED}
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByText("Discard changes?")).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
