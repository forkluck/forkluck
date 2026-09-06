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
import {
  createPrimoDraftStore,
  PrimoDraftProvider,
} from "@/components/primo/primo-drafts"
import { PrimoComposer } from "@/components/primo/primo-composer"
import { PrimoDropTarget } from "@/components/primo/primo-drop-target"

const state = vi.hoisted(() => ({
  conversationId: "00000000-0000-4000-8000-000000000001",
  conversationLoading: false,
  conversationError: "",
}))
vi.mock("@/components/primo/primo-provider", () => ({ usePrimo: () => state }))
vi.mock("@/app/(app)/actions", () => ({ runKitchenToolAction: vi.fn() }))
const fetchMock = vi.fn()
let stores: ReturnType<typeof createPrimoDraftStore>[] = []
const file = (name = "recipe.txt") => new File(["Flour 200 g"], name)
const item = (name = "recipe.txt") => ({
  id: crypto.randomUUID(),
  name,
  mediaType: "text/plain",
  size: 11,
  coverage: "Read document text.",
})
const ready = (name = "recipe.txt") => Response.json({ item: item(name) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
function store() {
  const value = createPrimoDraftStore("test")
  stores.push(value)
  return value
}
beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(ready()))
  vi.stubGlobal("fetch", fetchMock)
  state.conversationLoading = false
})
afterEach(() => {
  cleanup()
  stores.forEach((s) => s.dispose())
  stores = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("conversation-owned uploads", () => {
  it("reserves concurrent batches once and names every rejected file", async () => {
    const drafts = store()
    drafts.addFiles("a", [
      file("one.txt"),
      file("empty.txt"),
      file("first-rejected.exe"),
    ])
    drafts.addFiles("a", [
      file("three.txt"),
      file("four.txt"),
      file("five.txt"),
      file("six.txt"),
      file("no.exe"),
      new File([], "blank.txt"),
    ])
    expect(drafts.get("a").files).toHaveLength(5)
    expect(drafts.get("a").fileErrors?.join(" ")).toMatch(
      /first-rejected.exe.*six.txt.*no.exe.*blank.txt/
    )
    await vi.waitFor(() =>
      expect(drafts.get("a").files.every((f) => f.status === "ready")).toBe(
        true
      )
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
  it("enforces the aggregate byte limit across separate drops", async () => {
    const drafts = store()
    const large = (name: string) => new File([new Uint8Array(7_000_000)], name)
    drafts.addFiles("a", [large("one.txt"), large("two.txt")])
    drafts.addFiles("a", [large("three.txt")])
    expect(drafts.get("a").files).toHaveLength(2)
    expect(drafts.get("a").fileErrors?.[0]).toContain("20 MB")
    await vi.waitFor(() =>
      expect(drafts.get("a").files[0].status).toBe("ready")
    )
  })
  it("shows reading after headers and handles an error in an HTTP 200 body", async () => {
    const body = deferred<unknown>()
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => body.promise })
    const drafts = store()
    drafts.addFiles("a", [file()])
    expect(drafts.get("a").files[0].status).toBe("uploading")
    await vi.waitFor(() =>
      expect(drafts.get("a").files[0].status).toBe("reading")
    )
    body.resolve({ error: "Reading took too long. Try again." })
    await vi.waitFor(() =>
      expect(drafts.get("a").files[0].status).toBe("error")
    )
    await drafts.upload("a", drafts.get("a").files[0].id)
    expect(drafts.get("a").files[0].status).toBe("ready")
  })
  it("binds late completions to the original chat and restores ready files on reload", async () => {
    const request = deferred<Response>()
    fetchMock.mockReturnValueOnce(request.promise)
    const drafts = store()
    drafts.addFiles("a", [file()])
    drafts.set("b", () => ({ text: "Another chat", files: [], mentions: [] }))
    request.resolve(ready())
    await vi.waitFor(() =>
      expect(drafts.get("a").files[0].status).toBe("ready")
    )
    expect(drafts.get("b").files).toEqual([])
    const restored = store()
    expect(restored.get("a").files[0].status).toBe("ready")
    expect(createPrimoDraftStore("other-user").get("a").files).toEqual([])
  })
  it("cancels in-flight removal without resurrecting a late response", async () => {
    const request = deferred<Response>()
    fetchMock.mockReturnValueOnce(request.promise)
    const drafts = store()
    drafts.addFiles("a", [file()])
    const signal = fetchMock.mock.calls[0][1].signal
    await drafts.removeFile("a", drafts.get("a").files[0].id)
    expect(signal.aborted).toBe(true)
    request.resolve(ready())
    await request.promise
    await Promise.resolve()
    expect(drafts.get("a").files).toEqual([])
  })
  it("restores interrupted files as actionable errors and retains failed removals", async () => {
    const drafts = store()
    drafts.set("a", () => ({
      text: "Keep this",
      mentions: [],
      files: [{ id: "upload", name: "scan.pdf", size: 12, status: "reading" }],
    }))
    expect(store().get("a").files[0].error).toContain("Attach this file again")
    drafts.addFiles("b", [file()])
    await vi.waitFor(() =>
      expect(drafts.get("b").files[0].status).toBe("ready")
    )
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }))
    await drafts.removeFile("b", drafts.get("b").files[0].id)
    expect(drafts.get("b").files[0].error).toContain("Couldn’t remove")
  })
})

function Surface({
  busy = false,
  send = vi.fn(),
}: {
  busy?: boolean
  send?: () => Promise<void>
}) {
  return (
    <PrimoDraftProvider userId="surface">
      <PrimoDropTarget>
        <h1>Kitchen greeting</h1>
        <div>Previous messages</div>
        <PrimoComposer
          conversationId={state.conversationId}
          recipeOpen={false}
          busy={busy}
          onSend={send}
          onStop={vi.fn()}
        />
      </PrimoDropTarget>
    </PrimoDraftProvider>
  )
}
describe("file entry points", () => {
  it.each(["Kitchen greeting", "Previous messages", "Message Primo"])(
    "accepts a drop over %s while answering",
    async (label) => {
      render(<Surface busy />)
      const target =
        label === "Message Primo"
          ? screen.getByRole("textbox")
          : screen.getByText(label)
      const dataTransfer = { types: ["Files"], files: [file()] }
      fireEvent.dragEnter(target, { dataTransfer })
      expect(screen.getByText("Drop recipes or invoices here")).toBeDefined()
      fireEvent.drop(target, { dataTransfer })
      await screen.findByText("Read document text.")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull()
    }
  )
  it("shares picker and paste with drops and restores a failed-send draft", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Disconnected"))
    render(<Surface send={send} />)
    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [file("one.txt")] },
    })
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [file("two.txt")] },
    })
    await waitFor(() =>
      expect(screen.getAllByText("Read document text.")).toHaveLength(2)
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Read both recipes" },
    })
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    )
    expect(send.mock.calls[0][2]).toHaveLength(2)
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Read both recipes"
    )
    expect(screen.getAllByText("Read document text.")).toHaveLength(2)
  })
  it("ignores text drags and blocks file admission while the conversation loads", () => {
    state.conversationLoading = true
    render(<Surface />)
    const target = screen.getByText("Kitchen greeting")
    fireEvent.dragEnter(target, {
      dataTransfer: { types: ["text/plain"], files: [] },
    })
    expect(screen.queryByText("Drop recipes or invoices here")).toBeNull()
    fireEvent.drop(target, {
      dataTransfer: { types: ["Files"], files: [file()] },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
