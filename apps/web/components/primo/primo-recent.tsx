"use client"
import * as React from "react"
import {
  Archive,
  Clock,
  SquarePen,
  Trash2,
  Plus,
  Check,
  ChevronDown,
} from "lucide-react"
import { listPrimoConversations } from "@/lib/primo/conversations"
import { usePrimo } from "@/components/primo/primo-provider"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input, SearchInput } from "@/components/ui/input"
import { MenuItem } from "@/components/ui/menu"
import { RowActionsMenu } from "@/components/ui/row-actions"
import { Switch } from "@/components/ui/switch"
import { LoadingRegion } from "@/components/ui/loading-region"
import { useToast } from "@/components/ui/toast"
import { Spinner } from "@/components/ui/spinner"
import { groupConversationsByDate } from "@/lib/primo/conversation-groups"
import type { PrimoConversationSummary } from "@/lib/backend/types"

function RecentList({ close }: { close: () => void }) {
  const toast = useToast()
  const {
    conversationId,
    selectConversation,
    newChat,
    renameConversation,
    archiveConversation,
    deleteConversation,
  } = usePrimo()
  const [rows, setRows] = React.useState<PrimoConversationSummary[]>([])
  const [query, setQuery] = React.useState("")
  const [archived, setArchived] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [hasMore, setHasMore] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [revision, reload] = React.useReducer((n) => n + 1, 0)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const [pending, setPending] = React.useState<string | null>(null)
  const [deleting, setDeleting] =
    React.useState<PrimoConversationSummary | null>(null)
  React.useEffect(() => {
    let current = true
    const timer = window.setTimeout(
      () => {
        setLoading(true)
        setError("")
        void listPrimoConversations({ query, archived, page })
          .then((result) => {
            if (!current) return
            if ("error" in result) {
              setError(result.error)
              return
            }
            setRows((previous) =>
              page === 1
                ? result.items
                : [
                    ...previous.filter(
                      (row) => !result.items.some((item) => item.id === row.id)
                    ),
                    ...result.items,
                  ]
            )
            setHasMore(Boolean(result.meta.pagination.next))
          })
          .catch(() => {
            if (current) setError("Couldn’t load recent chats.")
          })
          .finally(() => {
            if (current) setLoading(false)
          })
      },
      query ? 200 : 0
    )
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [archived, query, page, revision])
  async function mutate(
    id: string,
    operation: () => Promise<string | null>,
    kind: "rename" | "archive" | "delete"
  ) {
    if (pending !== null) return
    setPending(id)
    setError("")
    try {
      const failure = await operation()
      if (failure) {
        setError(failure)
        return
      }
      setRows((rows) =>
        kind === "rename"
          ? rows.map((row) =>
              row.id === id ? { ...row, title: title.trim() } : row
            )
          : rows.filter((row) => row.id !== id)
      )
      setRenaming(null)
      setDeleting(null)
      toast.add({
        title:
          kind === "rename"
            ? "Chat renamed"
            : kind === "delete"
              ? "Chat deleted"
              : archived
                ? "Chat restored"
                : "Chat archived",
      })
      setPage(1)
      reload()
    } catch {
      setError("Couldn’t update that chat. Try again.")
    } finally {
      setPending(null)
    }
  }
  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <SearchInput
          value={query}
          disabled={pending !== null}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
            setLoading(true)
          }}
          label="Search chats"
          placeholder="Search chats…"
          className="max-w-none min-w-0 flex-1"
          inputClassName="text-lg md:text-md"
        />
        <Button
          variant="secondary"
          disabled={pending !== null}
          onClick={() => {
            newChat()
            close()
          }}
        >
          <Plus aria-hidden="true" />
          New chat
        </Button>
      </div>
      {error ? (
        <div role="alert" className="pb-2 text-md text-destructive">
          {error}
          <Button variant="ghost" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : null}
      {/* The first load is one ring centered in the room the rows will take,
          so the dialog opens at its working height; a reload over rows that
          are already showing dims them under the ring instead. */}
      <LoadingRegion pending={loading && rows.length > 0} label="Loading chats">
        <div className="-mx-2 max-h-[55dvh] min-h-60 overflow-y-auto px-2 pb-2">
          {rows.length ? (
            groupConversationsByDate(rows).map((group) => (
              <section key={group.label} className="mb-3">
                <h3 className="py-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </h3>
                {group.items.map((row) => (
                  <div
                    key={row.id}
                    className="-mx-2 flex min-h-11 items-center gap-1 rounded-lg px-2 hover:bg-muted"
                  >
                    {renaming === row.id ? (
                      <>
                        <Input
                          autoFocus
                          value={title}
                          maxLength={200}
                          aria-label="Conversation title"
                          disabled={pending !== null}
                          onChange={(event) => setTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setRenaming(null)
                            if (event.key === "Enter" && title.trim())
                              void mutate(
                                row.id,
                                () => renameConversation(row.id, title.trim()),
                                "rename"
                              )
                          }}
                          className="h-8 flex-1 px-2"
                        />
                        <Button
                          size="icon-compact"
                          variant="ghost"
                          aria-label="Save title"
                          pending={pending === row.id}
                          disabled={!title.trim() || pending !== null}
                          onClick={() =>
                            void mutate(
                              row.id,
                              () => renameConversation(row.id, title.trim()),
                              "rename"
                            )
                          }
                        >
                          <Check aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-md"
                        disabled={pending !== null}
                        aria-current={
                          row.id === conversationId ? "true" : undefined
                        }
                        onClick={() => {
                          selectConversation(row.id)
                          close()
                        }}
                      >
                        <span className="flex-1 truncate">
                          {row.title || "New chat"}
                        </span>
                        {row.id === conversationId ? (
                          <Check className="size-4" aria-hidden="true" />
                        ) : null}
                      </button>
                    )}
                    <RowActionsMenu
                      label={`Actions for ${row.title || "New chat"}`}
                    >
                      <MenuItem
                        disabled={pending !== null}
                        onClick={() => {
                          setTitle(row.title)
                          setRenaming(row.id)
                        }}
                      >
                        <SquarePen aria-hidden="true" />
                        Rename
                      </MenuItem>
                      <MenuItem
                        disabled={pending !== null}
                        onClick={() =>
                          void mutate(
                            row.id,
                            () => archiveConversation(row.id, !archived),
                            "archive"
                          )
                        }
                      >
                        <Archive aria-hidden="true" />
                        {archived ? "Unarchive" : "Archive"}
                      </MenuItem>
                      <MenuItem
                        disabled={pending !== null}
                        className="text-destructive"
                        onClick={() => {
                          setError("")
                          setDeleting(row)
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                        Delete
                      </MenuItem>
                    </RowActionsMenu>
                    {pending === row.id ? (
                      <span
                        role="status"
                        className="text-md text-muted-foreground"
                      >
                        Saving…
                      </span>
                    ) : null}
                  </div>
                ))}
              </section>
            ))
          ) : loading ? (
            <div className="grid min-h-60 place-items-center">
              <Spinner size="md" delayed label="Loading chats" />
            </div>
          ) : !error ? (
            <p className="py-8 text-center text-md text-muted-foreground">
              {query
                ? "No chats match your search."
                : archived
                  ? "No archived chats."
                  : "No recent chats yet."}
            </p>
          ) : null}
        </div>
      </LoadingRegion>
      {hasMore ? (
        <Button
          className="mb-3"
          variant="secondary"
          pending={loading}
          onClick={() => setPage((value) => value + 1)}
        >
          Load more
        </Button>
      ) : null}
      <label className="-mx-6 mt-2 flex h-11 items-center justify-between border-t border-border px-6 text-md">
        Show archived chats
        <Switch
          checked={archived}
          disabled={pending !== null}
          onCheckedChange={(value) => {
            setArchived(value)
            setPage(1)
            setLoading(true)
          }}
        />
      </label>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title="Delete this chat?"
        description={
          <>
            {`“${deleting?.title || "New chat"}”, its messages and attachments will be permanently deleted.`}
            {error ? (
              <span role="alert" className="mt-2 block text-destructive">
                {error}
              </span>
            ) : null}
          </>
        }
        pending={pending !== null}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting)
            await mutate(
              deleting.id,
              () => deleteConversation(deleting.id),
              "delete"
            )
        }}
      />
    </>
  )
}
export function PrimoRecent({ title }: { title?: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        variant="ghost"
        aria-label={title ? `Recent chats: ${title}` : "Recent chats"}
        className={
          title
            ? "mr-auto min-w-0 justify-start text-foreground"
            : "text-ink-soft"
        }
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {title ? (
          <>
            <span className="truncate">{title}</span>
            <ChevronDown aria-hidden="true" />
          </>
        ) : (
          <>
            <Clock aria-hidden="true" />
            <span>Recent</span>
          </>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="gap-0 pb-0">
          <DialogHeader className="mb-4">
            <DialogTitle>Recent chats</DialogTitle>
            <DialogDescription className="sr-only">
              Find and manage your conversations with Primo.
            </DialogDescription>
          </DialogHeader>
          {open ? <RecentList close={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
