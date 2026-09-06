// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

const runKitchenTool = vi.hoisted(() => vi.fn())
vi.mock("@/app/(app)/actions", () => ({
  runKitchenToolAction: (name: string, input: unknown) =>
    runKitchenTool(name, input),
}))

import { PrimoComposer } from "@/components/primo/primo-composer"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.localStorage.clear()
})

beforeEach(() => {
  vi.clearAllMocks()
  runKitchenTool.mockResolvedValue({
    ok: true,
    tool: "find_recipes",
    query: "moon",
    more: false,
    ambiguous: [],
    recipes: [{ recipeRef: "rcp_0123456789ab", title: "Mooncake" }],
  })
})

describe("Primo composer", () => {
  it("accepts ordinary kitchen questions", () => {
    const onSend = vi.fn()
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    expect(composer.hasAttribute("disabled")).toBe(false)
    expect(composer.getAttribute("placeholder")).toBe(
      "Ask Primo about the kitchen…"
    )
    fireEvent.change(composer, { target: { value: "Find garlic" } })
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(onSend).toHaveBeenCalledWith("Find garlic", [])
  })

  it("binds an @ mention to the selected recipe identity", async () => {
    const onSend = vi.fn()
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )
    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    fireEvent.change(composer, {
      target: { value: "We need 600 portions of @moon" },
    })

    await waitFor(() =>
      expect(runKitchenTool).toHaveBeenCalledWith("find_recipes", {
        query: "moon",
      })
    )
    fireEvent.click(await screen.findByRole("option", { name: "Mooncake" }))
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("We need 600 portions of @Mooncake", [
        {
          kind: "recipe",
          label: "Mooncake",
          ref: "rcp_0123456789ab",
        },
      ])
    )
  })

  it("uses the keyboard to pick, keeps focus, and Escape closes the list", async () => {
    runKitchenTool.mockResolvedValue({
      ok: true,
      tool: "find_recipes",
      query: "moon",
      more: false,
      ambiguous: [],
      recipes: [
        { recipeRef: "rcp_0123456789ab", title: "Mooncake" },
        { recipeRef: "rcp_bbbbbbbbbbbb", title: "Moon Pie" },
      ],
    })
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )
    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    fireEvent.change(composer, { target: { value: "Make @moon" } })
    await screen.findByRole("option", { name: "Mooncake" })
    fireEvent.keyDown(composer, { key: "ArrowDown" })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect((composer as HTMLTextAreaElement).value).toBe("Make @Moon Pie ")

    fireEvent.change(composer, { target: { value: "Make @moon" } })
    await screen.findByRole("listbox", { name: "Recipes and products" })
    fireEvent.keyDown(composer, { key: "Escape" })
    expect(
      screen.queryByRole("listbox", { name: "Recipes and products" })
    ).toBeNull()
  })

  it("removes a picked token and its binding with Backspace", async () => {
    const onSend = vi.fn()
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )
    const composer = screen.getByRole("textbox", {
      name: "Message Primo",
    }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: "Make @moon" } })
    fireEvent.click(await screen.findByRole("option", { name: "Mooncake" }))
    const afterToken = composer.value.indexOf("@Mooncake") + "@Mooncake".length
    composer.setSelectionRange(afterToken, afterToken)
    fireEvent.select(composer)
    fireEvent.keyDown(composer, { key: "Backspace" })
    expect(composer.value).not.toContain("@Mooncake")
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("Make", [])
  })

  it("does not bind a recipe that was only typed or pasted", () => {
    const onSend = vi.fn()
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )
    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    fireEvent.change(composer, { target: { value: "Make @mooncake" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("Make @mooncake", [])
  })

  it("announces an empty recipe search", async () => {
    runKitchenTool.mockResolvedValue({
      ok: true,
      tool: "find_recipes",
      query: "zzzz",
      more: false,
      ambiguous: [],
      recipes: [],
    })
    render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Message Primo" }), {
      target: { value: "Make @zzzz" },
    })
    expect(
      await screen.findByText("No recipes or products match that.")
    ).toBeDefined()
  })

  it("keeps Shift+Enter for a new line and exposes Stop while streaming", () => {
    const onSend = vi.fn()
    const { rerender } = render(
      <PrimoComposer recipeOpen busy={false} onSend={onSend} onStop={vi.fn()} />
    )
    const composer = screen.getByRole("textbox", { name: "Message Primo" })
    fireEvent.change(composer, { target: { value: "What changed?" } })
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("What changed?", [])

    rerender(<PrimoComposer recipeOpen busy onSend={onSend} onStop={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Stop Primo" })).toBeDefined()
  })

  it("saves, restores, and clears the per-conversation draft", () => {
    vi.useFakeTimers()
    window.localStorage.setItem(
      "primo:draft-v2:local:conversation-1",
      JSON.stringify({ text: "Saved prep note", mentions: [], files: [] })
    )
    const onSend = vi.fn()
    const view = render(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
        conversationId="conversation-1"
      />
    )
    const composer = screen.getByRole("textbox", {
      name: "Message Primo",
    }) as HTMLTextAreaElement
    act(() => vi.advanceTimersByTime(0))
    expect(composer.value).toBe("Saved prep note")
    fireEvent.change(composer, { target: { value: "Updated prep note" } })
    act(() => vi.advanceTimersByTime(300))
    expect(
      JSON.parse(
        window.localStorage.getItem("primo:draft-v2:local:conversation-1")!
      ).text
    ).toBe("Updated prep note")
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(
      window.localStorage.getItem("primo:draft-v2:local:conversation-1")
    ).toBeNull()
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(composer)

    view.rerender(
      <PrimoComposer
        recipeOpen={false}
        busy={false}
        onSend={onSend}
        onStop={vi.fn()}
        conversationId="conversation-2"
      />
    )
    expect(composer.value).toBe("")
  })
})
