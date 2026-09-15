// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { ToastProvider } from "@/components/ui/toast"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  archive: vi.fn(),
}))
vi.mock("@/lib/primo/conversations", () => ({
  listPrimoConversations: mocks.list,
}))
vi.mock("@/components/primo/primo-provider", () => ({
  usePrimo: () => ({
    conversationId: "saved",
    selectConversation: vi.fn(),
    newChat: vi.fn(),
    deleteConversation: mocks.remove,
    renameConversation: mocks.rename,
    archiveConversation: mocks.archive,
  }),
}))
import { PrimoRecent } from "@/components/primo/primo-recent"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it("keeps delete confirmation pending, shows failure inside it, and removes the row only after success", async () => {
  const row = {
    id: "saved",
    title: "Synthetic saved chat",
    isArchived: false,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: new Date(),
  }
  let rows = [row]
  mocks.list.mockImplementation(async () => ({
    items: rows,
    meta: { pagination: { next: null } },
  }))
  let finish!: (failure: string | null) => void
  mocks.remove.mockImplementation(
    () =>
      new Promise<string | null>((resolve) => {
        finish = resolve
      })
  )
  render(
    <ToastProvider>
      <PrimoRecent />
    </ToastProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Recent chats" }))
  await screen.findByRole("button", { name: row.title })
  fireEvent.click(
    screen.getByRole("button", { name: `Actions for ${row.title}` })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
  const confirmation = screen.getByRole("dialog", { name: "Delete this chat?" })
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }))
  expect(
    within(confirmation).getByRole("button", { name: "Cancel" })
  ).toHaveProperty("disabled", true)
  expect(mocks.remove).toHaveBeenCalledTimes(1)
  await act(async () => finish("Couldn’t delete that chat."))
  expect(within(confirmation).getByRole("alert").textContent).toContain(
    "Couldn’t delete"
  )
  expect(
    within(confirmation).getByRole("button", { name: "Cancel" })
  ).toHaveProperty("disabled", false)
  expect(rows).toHaveLength(1)
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }))
  rows = []
  await act(async () => finish(null))
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Delete this chat?" })
    ).toBeNull()
  )
  expect(screen.queryByRole("button", { name: row.title })).toBeNull()
  expect(screen.getByText("Chat deleted")).toBeDefined()
})
