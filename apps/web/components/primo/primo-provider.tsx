"use client"

import * as React from "react"
import { PrimoDraftProvider } from "./primo-drafts"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { usePathname, useRouter } from "next/navigation"

import {
  archivePrimoConversation,
  deletePrimoConversation,
  renamePrimoConversation,
} from "@/app/(app)/actions"
import {
  listPrimoConversations,
  loadPrimoConversation,
} from "@/lib/primo/conversations"
import { useNavigationBlocker } from "@/components/navigation-blocker"
import type { PrimoConversationSummary } from "@/lib/backend/types"
import type { PrimoAttachment } from "@/lib/primo/attachments"
import {
  primoTurnStatus,
  type PrimoMention,
  type PrimoUIMessage,
} from "@/lib/primo/messages"

const RECIPE_PATH = /^\/recipes\/(rcp_[0-9abcdefghjkmnpqrstvwxyz]{12})(?:\/|$)/
const PRODUCT_PATH =
  /^\/products\/(prd_[0-9abcdefghjkmnpqrstvwxyz]{12})(?:\/|$)/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function primoRouteContext(pathname: string) {
  return {
    recipeRef: pathname.match(RECIPE_PATH)?.[1] ?? null,
    productRef: pathname.match(PRODUCT_PATH)?.[1] ?? null,
  }
}

function newConversationId() {
  return crypto.randomUUID()
}

function valueCell<Value>(initial: Value) {
  let current = initial
  return {
    get: () => current,
    set: (next: Value) => {
      current = next
    },
  }
}

type PrimoContextValue = {
  chat: ReturnType<typeof useChat<PrimoUIMessage>>
  open: boolean
  setOpen: (open: boolean) => void
  isDesktop: boolean
  inlineCount: number
  registerInline: () => () => void
  actionLine: string
  showAction: (line: string) => void
  navigate: (href: string) => Promise<void>
  send: (
    text: string,
    mentions?: PrimoMention[],
    attachments?: PrimoAttachment[]
  ) => Promise<void>
  conversationId: string
  conversationError: string
  reloadConversation: () => void
  conversationLoading: boolean
  conversations: PrimoConversationSummary[]
  recentArchived: boolean
  newChat: () => void
  selectConversation: (id: string) => void
  loadRecent: (archived?: boolean) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<string | null>
  archiveConversation: (id: string, archived: boolean) => Promise<string | null>
  deleteConversation: (id: string) => Promise<string | null>
  route: { recipeRef: string | null; productRef: string | null }
}

const PrimoContext = React.createContext<PrimoContextValue | null>(null)

export function usePrimo() {
  const value = React.useContext(PrimoContext)
  if (!value) throw new Error("usePrimo must be used inside PrimoProvider")
  return value
}

export function PrimoProvider({
  children,
  userId = "local",
}: {
  children: React.ReactNode
  userId?: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { allowNavigation, confirmNavigation } = useNavigationBlocker()
  const route = React.useMemo(() => primoRouteContext(pathname), [pathname])
  const [routeContext] = React.useState(() => valueCell(route))
  React.useLayoutEffect(() => {
    routeContext.set(route)
  }, [route, routeContext])
  const [initialConversation] = React.useState(() => ({
    id: newConversationId(),
    saved: false,
  }))
  const [restored, setRestored] = React.useState(false)
  const [conversationId, setConversationId] = React.useState(
    initialConversation.id
  )
  React.useEffect(() => {
    const linkedValue = new URLSearchParams(window.location.search).get("c")
    const linked = linkedValue && UUID.test(linkedValue) ? linkedValue : null
    let stored: string | null = null
    try {
      const value = window.localStorage.getItem(
        userId === "local" ? "primo:active" : `primo:active:${userId}`
      )
      stored = value && UUID.test(value) ? value : null
    } catch {}
    let active = true
    queueMicrotask(() => {
      if (!active) return
      if (linked || stored) setConversationId(linked || stored!)
      setRestored(true)
    })
    return () => {
      active = false
    }
  }, [userId])
  const [conversationContext] = React.useState(() =>
    valueCell(initialConversation.id)
  )
  const newConversationIds = React.useRef(
    new Set(initialConversation.saved ? [] : [initialConversation.id])
  )
  const [conversations, setConversations] = React.useState<
    PrimoConversationSummary[]
  >([])
  const [recentArchived, setRecentArchived] = React.useState(false)
  const [conversationError, setConversationError] = React.useState("")
  const [loadVersion, reloadConversation] = React.useReducer((n) => n + 1, 0)
  const [conversationLoading, setConversationLoading] = React.useState(true)
  const [transport] = React.useState(
    () =>
      new DefaultChatTransport<PrimoUIMessage>({
        api: "/api/primo/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            conversationId: conversationContext.get(),
            parentMessageId:
              messages.findLast((message) => message.role === "assistant")
                ?.id ?? "",
            ...routeContext.get(),
          },
        }),
      })
  )
  const sendError = React.useRef<Error | null>(null)
  const chat = useChat<PrimoUIMessage>({
    transport,
    onError: (error) => {
      sendError.current = error
    },
    onFinish: ({ message, isAbort, isError, isDisconnect, finishReason }) => {
      chatRef.current.setMessages((current) =>
        current.map((row) =>
          row.id === message.id
            ? {
                ...row,
                status: primoTurnStatus(message, {
                  aborted: isAbort,
                  errored: isError || isDisconnect,
                  finishReason,
                }),
              }
            : row
        )
      )
    },
    onData: (part) => {
      if (part.type !== "data-title") return
      newConversationIds.current.delete(part.data.conversationId)
      const now = new Date()
      setConversations((current) => {
        const found = current.find((row) => row.id === part.data.conversationId)
        const row: PrimoConversationSummary = found
          ? { ...found, title: part.data.title, lastMessageAt: now }
          : {
              id: part.data.conversationId,
              title: part.data.title,
              isArchived: false,
              archivedAt: null,
              lastMessageAt: now,
              createdAt: now,
              updatedAt: now,
            }
        return [row, ...current.filter((item) => item.id !== row.id)]
      })
    },
  })
  const chatRef = React.useRef(chat)
  React.useEffect(() => {
    chatRef.current = chat
  }, [chat])
  const [open, setOpenState] = React.useState(false)
  const [isDesktop, setIsDesktop] = React.useState(false)
  const [inlineCount, setInlineCount] = React.useState(0)
  const [actionLine, setActionLine] = React.useState("")
  const actionTimer = React.useRef<number | null>(null)
  const [navigationPending, startTransition] = React.useTransition()
  const pendingNavigation = React.useRef<{
    sawPending: boolean
    settle: () => void
  } | null>(null)

  React.useEffect(() => {
    if (!restored) return
    conversationContext.set(conversationId)
    try {
      window.localStorage.setItem(
        userId === "local" ? "primo:active" : `primo:active:${userId}`,
        conversationId
      )
    } catch {}
    if (newConversationIds.current.has(conversationId)) {
      try {
        window.localStorage.setItem(`primo:unsent:${userId}`, conversationId)
      } catch {}
      setConversationLoading(false)
      return
    }
    let current = true
    setConversationLoading(true)
    setConversationError("")
    chatRef.current.stop()
    chatRef.current.setMessages([])
    void loadPrimoConversation(conversationId)
      .then((result) => {
        if (!current) return
        if ("item" in result && result.item) {
          try {
            if (
              window.localStorage.getItem(`primo:unsent:${userId}`) ===
              conversationId
            )
              window.localStorage.removeItem(`primo:unsent:${userId}`)
          } catch {}
          chatRef.current.setMessages(result.item.messages as PrimoUIMessage[])
        } else {
          let unsent = false
          try {
            unsent =
              window.localStorage.getItem(`primo:unsent:${userId}`) ===
                conversationId &&
              "error" in result &&
              result.error === "Conversation not found"
          } catch {}
          if (unsent) {
            newConversationIds.current.add(conversationId)
            setConversationLoading(false)
            return
          }
          setConversationError(
            "error" in result ? result.error : "Couldn’t load that chat."
          )
        }
        setConversationLoading(false)
      })
      .catch(() => {
        if (current) {
          setConversationError("Couldn’t load that chat.")
          setConversationLoading(false)
        }
      })
    return () => {
      current = false
    }
  }, [conversationContext, conversationId, loadVersion, userId, restored])

  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)")
    const update = () => setIsDesktop(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  const setOpen = React.useCallback((next: boolean) => setOpenState(next), [])
  const registerInline = React.useCallback(() => {
    setInlineCount((count) => count + 1)
    return () => setInlineCount((count) => Math.max(0, count - 1))
  }, [])
  const showAction = React.useCallback((line: string) => {
    setActionLine(line)
    if (actionTimer.current !== null) window.clearTimeout(actionTimer.current)
    actionTimer.current = window.setTimeout(() => setActionLine(""), 4_000)
  }, [])
  React.useEffect(
    () => () => {
      if (actionTimer.current !== null) window.clearTimeout(actionTimer.current)
    },
    []
  )

  React.useEffect(() => {
    const pending = pendingNavigation.current
    if (!pending) return
    if (navigationPending) {
      pending.sawPending = true
    } else if (pending.sawPending) {
      pending.settle()
    }
  }, [navigationPending])

  React.useEffect(
    () => () => {
      pendingNavigation.current?.settle()
    },
    []
  )

  const navigate = React.useCallback(
    async (href: string) => {
      if (!(await confirmNavigation())) return
      allowNavigation()
      await new Promise<void>((resolve) => {
        let settled = false
        pendingNavigation.current?.settle()
        let timeout = 0
        const finish = () => {
          if (settled) return
          settled = true
          window.clearTimeout(timeout)
          pendingNavigation.current = null
          resolve()
        }
        pendingNavigation.current = { sawPending: false, settle: finish }
        timeout = window.setTimeout(finish, 3_000)
        startTransition(() => router.push(href))
      })
    },
    [allowNavigation, confirmNavigation, router]
  )

  const send = React.useCallback(
    async (
      text: string,
      mentions: PrimoMention[] = [],
      attachments: PrimoAttachment[] = []
    ) => {
      if (
        conversationLoading ||
        conversationError ||
        chat.status === "submitted" ||
        chat.status === "streaming"
      )
        return
      newConversationIds.current.delete(conversationId)
      const previous = chat.messages.findLast(
        (message) => message.role === "user"
      )
      const retryId =
        chat.error &&
        previous &&
        (attachments.some((file) =>
          previous.metadata?.attachmentIds?.includes(file.id)
        ) ||
          (attachments.length === 0 &&
            !previous.metadata?.attachmentIds?.length &&
            previous.parts.some(
              (part) => part.type === "text" && part.text === text
            )))
          ? previous.id
          : undefined
      sendError.current = null
      await chat.sendMessage({
        ...(retryId ? { messageId: retryId } : {}),
        text,
        metadata: {
          mentions,
          attachments,
          attachmentIds: attachments.map((file) => file.id),
          createdAt: new Date().toISOString(),
        },
      })
      if (sendError.current) throw sendError.current
    },
    [chat, conversationId, conversationLoading, conversationError]
  )

  const newChat = React.useCallback(() => {
    void chat.stop()
    chat.clearError?.()
    const id = newConversationId()
    newConversationIds.current.add(id)
    conversationContext.set(id)
    setConversationError("")
    setConversationId(id)
    chat.setMessages([])
    if (pathname === "/") window.history.replaceState(null, "", "/")
  }, [chat, conversationContext, pathname])

  const selectConversation = React.useCallback(
    (id: string) => {
      if (id === conversationId) return
      void chatRef.current.stop()
      chatRef.current.clearError?.()
      conversationContext.set(id)
      setConversationId(id)
      if (pathname === "/") {
        window.history.replaceState(null, "", `/?c=${encodeURIComponent(id)}`)
      }
    },
    [conversationId, conversationContext, pathname]
  )

  const loadRecent = React.useCallback(async (archived = false) => {
    setRecentArchived(archived)
    const result = await listPrimoConversations({ archived })
    if (!("error" in result)) setConversations(result.items)
  }, [])

  const renameConversation = React.useCallback(
    async (id: string, title: string) => {
      const before = conversations
      setConversations((rows) =>
        rows.map((row) => (row.id === id ? { ...row, title } : row))
      )
      const result = await renamePrimoConversation(id, title)
      if ("error" in result) {
        setConversations(before)
        return result.error
      }
      setConversations((rows) =>
        rows.map((row) => (row.id === id ? result.item : row))
      )
      return null
    },
    [conversations]
  )

  const archiveConversation = React.useCallback(
    async (id: string, archived: boolean) => {
      const before = conversations
      setConversations((rows) => rows.filter((row) => row.id !== id))
      const result = await archivePrimoConversation(id, archived)
      if ("error" in result) {
        setConversations(before)
        return result.error
      }
      return null
    },
    [conversations]
  )

  const deleteConversation = React.useCallback(
    async (id: string) => {
      const before = conversations
      setConversations((rows) => rows.filter((row) => row.id !== id))
      const result = await deletePrimoConversation(id)
      if ("error" in result) {
        setConversations(before)
        return result.error
      }
      if (id === conversationId) newChat()
      return null
    },
    [conversationId, conversations, newChat]
  )

  const value = React.useMemo<PrimoContextValue>(
    () => ({
      chat,
      open,
      setOpen,
      isDesktop,
      inlineCount,
      registerInline,
      actionLine,
      showAction,
      navigate,
      send,
      conversationId,
      conversationLoading,
      conversationError,
      reloadConversation,
      conversations,
      recentArchived,
      newChat,
      selectConversation,
      loadRecent,
      renameConversation,
      archiveConversation,
      deleteConversation,
      route,
    }),
    [
      actionLine,
      chat,
      archiveConversation,
      conversationId,
      conversationLoading,
      conversationError,
      reloadConversation,
      conversations,
      deleteConversation,
      inlineCount,
      isDesktop,
      navigate,
      newChat,
      open,
      registerInline,
      recentArchived,
      renameConversation,
      route,
      send,
      selectConversation,
      loadRecent,
      setOpen,
      showAction,
    ]
  )
  return (
    <PrimoDraftProvider userId={userId}>
      <PrimoContext.Provider value={value}>{children}</PrimoContext.Provider>
    </PrimoDraftProvider>
  )
}
