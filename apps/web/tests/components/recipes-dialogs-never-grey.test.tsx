// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const shareRecipe = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/recipes/actions", () => ({
  removeRecipeGuestLink: vi.fn(),
  removeRecipeShare: vi.fn(),
  shareRecipe,
  updateRecipeShare: vi.fn(),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import { CustomBatchDialog } from "@/components/recipes/custom-batch-dialog"
import { ImportRecipeDialog } from "@/components/recipes/import-recipe-dialog"
import { ShareDialog } from "@/components/recipes/share-dialog"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the share dialog's Share button", () => {
  function open() {
    render(
      <ShareDialog
        open
        onOpenChange={vi.fn()}
        recipeId="rec-1"
        ownerName="Alex"
        shares={[]}
        guestLinks={[]}
        canEdit
      />
    )
  }

  it("stays enabled with no email", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Share" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for an email instead of sharing", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(shareRecipe).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain("Enter an email.")
  })

  it("shares once an email is typed", async () => {
    shareRecipe.mockResolvedValue({ ok: true })
    open()
    fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
      target: { value: "guest@example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    await vi.waitFor(() => expect(shareRecipe).toHaveBeenCalled())
  })
})

describe("the import dialog's Import button", () => {
  function open(onApply = vi.fn()) {
    render(
      <ImportRecipeDialog
        open
        part="recipe"
        onOpenChange={vi.fn()}
        onApply={onApply}
      />
    )
    return onApply
  }

  it("stays enabled with both boxes empty", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "Import" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for something to import instead of applying", () => {
    const onApply = open()
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Paste ingredients or a method first."
    )
  })

  it("applies once a box is filled", () => {
    const onApply = open()
    fireEvent.change(screen.getByLabelText("Ingredients"), {
      target: { value: "500 g flour" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    expect(onApply).toHaveBeenCalled()
  })
})

describe("the custom batch dialog's buttons", () => {
  function open(props: Record<string, unknown> = {}) {
    const onApply = vi.fn()
    const onRewrite = vi.fn()
    render(
      <CustomBatchDialog
        open
        onOpenChange={vi.fn()}
        recipeYield={null}
        onApply={onApply}
        onRewrite={onRewrite}
        {...props}
      />
    )
    return { onApply, onRewrite }
  }

  it("keeps View enabled with no factor", () => {
    open()
    expect(
      (screen.getByRole("button", { name: "View" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("asks for a multiplier instead of viewing", () => {
    const { onApply } = open()
    fireEvent.click(screen.getByRole("button", { name: "View" }))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a multiplier or a target amount."
    )
  })

  it("views once a multiplier is typed", () => {
    const { onApply } = open()
    fireEvent.change(screen.getByPlaceholderText("7"), {
      target: { value: "2" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^View/ }))
    expect(onApply).toHaveBeenCalled()
  })

  it("asks for a multiplier instead of rewriting", () => {
    const { onRewrite } = open()
    fireEvent.click(screen.getByRole("button", { name: "Rewrite recipe" }))
    expect(onRewrite).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a multiplier or a target amount."
    )
  })

  it("rewrites once a multiplier is typed", () => {
    const { onRewrite } = open()
    fireEvent.change(screen.getByPlaceholderText("7"), {
      target: { value: "2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Rewrite recipe" }))
    expect(onRewrite).toHaveBeenCalled()
  })
})
