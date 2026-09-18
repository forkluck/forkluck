"use client"

import * as React from "react"
import { getToolName, isToolUIPart } from "ai"
import {
  Check,
  Copy,
  HatGlasses,
  RotateCcw,
  ArrowUpRight,
  Book,
  CalendarDays,
  ChartColumn,
  History,
  Package,
  Search,
  SquarePen,
  TrendingUp,
} from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { PrimoMarkdown } from "./primo-markdown"
import { PrimoAttachmentPreview } from "./primo-attachment-preview"
import { PrimoFeedback } from "./primo-feedback"
import { type PrimoAttachment } from "@/lib/primo/attachments"
import { GuardedLink } from "@/components/navigation-blocker"
import { PrimoComposer } from "@/components/primo/primo-composer"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoRecipeDraftCard } from "@/components/primo/primo-recipe-draft-card"
import { PrimoCostLinks } from "@/components/primo/primo-cost-links"
import { Bubble } from "@/components/ui/bubble"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Marker } from "@/components/ui/marker"
import { Message } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerItem,
} from "@/components/ui/message-scroller"
import type { RecipeCostDiff } from "@/lib/backend/types"
import { KITCHEN_TOOL_ACTION_LINES } from "@/lib/kitchen-tools/client"
import type {
  FindProductsResult,
  FindRecipesResult,
  RecipeBatchResult,
} from "@/lib/kitchen-tools/results"
import {
  primoMessageText,
  primoToolParts,
  primoToolSucceeded,
  primoTurnStatus,
  type PrimoMention,
  type PrimoUIMessage,
} from "@/lib/primo/messages"
import type { RecipeDraft } from "@/lib/recipe/draft"
import { formatCents, quantityFormat } from "@/lib/money"
import { cn } from "@/lib/utils"
import { useBusinessSettings } from "@/components/business-settings-provider"
import { formatDayMonthTime } from "@/lib/datetime"

type CostResult = RecipeCostDiff & { omittedLines?: number }

type Starter = { icon: typeof Book; question: string }

const homeStarterQuestions: Starter[] = [
  {
    icon: ChartColumn,
    question: "Which three products had the most net sales last month?",
  },
  { icon: Package, question: "What changed in ingredient costs?" },
  { icon: Book, question: "Help me create a recipe." },
]
const recipeStarterQuestions: Starter[] = [
  { icon: History, question: "What changed in this recipe?" },
  { icon: TrendingUp, question: "Why did this cost increase?" },
  {
    icon: CalendarDays,
    question: "Compare this recipe since the start of this year.",
  },
]
const generalStarterQuestions: Starter[] = [
  { icon: Search, question: "Find garlic in the USDA database." },
  { icon: Book, question: "Help me create a recipe." },
]

function WorkingMarker() {
  const [seconds, setSeconds] = React.useState(0)
  React.useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1_000)),
      1_000
    )
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="flex items-center gap-2 text-md leading-5 text-muted-foreground">
      <span
        className="size-2 rounded-full bg-foreground motion-safe:animate-pulse"
        aria-hidden="true"
      />
      <span>Primo is working on that…</span>
      {seconds >= 3 ? <span className="tabular-nums">{seconds}s</span> : null}
    </div>
  )
}

function highlightedText(text: string, mentions: PrimoMention[]) {
  if (!mentions.length) return text
  const labels = mentions.map((mention) => `@${mention.label}`)
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0
  while (remaining) {
    const candidates = labels
      .map((label) => ({ label, index: remaining.indexOf(label) }))
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index)
    const next = candidates[0]
    if (!next) {
      parts.push(remaining)
      break
    }
    if (next.index > 0) parts.push(remaining.slice(0, next.index))
    parts.push(<strong key={key++}>{next.label}</strong>)
    remaining = remaining.slice(next.index + next.label.length)
  }
  return parts
}

function AmbiguityChoices({
  result,
  onChoose,
  disabled,
}: {
  disabled: boolean
  result: FindRecipesResult | FindProductsResult
  onChoose: (text: string, mentions: PrimoMention[]) => void
}) {
  const choices =
    result.tool === "find_recipes"
      ? result.recipes.map((recipe) => ({
          kind: "recipe" as const,
          label: recipe.title,
          ref: recipe.recipeRef,
        }))
      : result.products.map((product) => ({
          kind: "product" as const,
          label: product.sku
            ? `${product.name} (${product.sku})`
            : product.name,
          ref: product.productRef,
        }))
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((choice) => (
        <Button
          key={choice.ref}
          disabled={disabled}
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            onChoose(`@${choice.label}`, [
              { kind: choice.kind, label: choice.label, ref: choice.ref },
            ])
          }
          className="h-auto py-1.5 whitespace-normal"
        >
          {choice.label}
        </Button>
      ))}
    </div>
  )
}

function BatchLine({ result }: { result: RecipeBatchResult }) {
  const details = [
    `${result.recipe.title} at ${result.label} · preview ready`,
    result.portions === null
      ? null
      : `${quantityFormat.format(result.portions)} portions`,
    result.cost
      ? `${formatCents(result.cost.ingredientTotalCents, result.cost.currencyCode)} batch`
      : "cost unavailable",
    result.cost?.portionCostCents === null || !result.cost
      ? null
      : `${formatCents(result.cost.portionCostCents, result.cost.currencyCode)} per portion`,
    "nothing saved",
  ].filter(Boolean)
  return <Marker>{details.join(" · ")}</Marker>
}

function missingReadAnswer(message: PrimoUIMessage) {
  if (message.status === "aborted") return false
  const lastToolIndex = message.parts.findLastIndex(isToolUIPart)
  const part = message.parts[lastToolIndex]
  if (!part || !isToolUIPart(part) || !primoToolSucceeded(part)) return false
  return (
    [
      "get_product_sales",
      "get_recipe_cost_change",
      "get_top_products",
      "get_ingredient_price_changes",
      "calculate_batch_cost",
      "search_usda_foods",
    ].includes(getToolName(part)) &&
    !message.parts
      .slice(lastToolIndex + 1)
      .some((part) => part.type === "text" && part.text.trim())
  )
}

function TurnStatus({
  message,
  transportError,
}: {
  message: PrimoUIMessage
  transportError: boolean
}) {
  const tools = primoToolParts(message)
  const status = primoTurnStatus(message, {
    errored:
      transportError ||
      message.status === "error" ||
      missingReadAnswer(message),
    aborted: message.status === "aborted",
    finishReason: message.metadata?.finishReason,
  })
  const loaded = tools.some(primoToolSucceeded)
  return status === "aborted" ? (
    <p className="text-md text-muted-foreground">Response stopped</p>
  ) : status === "error" ? (
    <p className="text-md text-destructive">
      {loaded
        ? "Results loaded; response interrupted. Try again."
        : tools.some((part) => getToolName(part) === "draft_recipe")
          ? "Recipe draft interrupted. Try again."
          : "Response interrupted. Try again."}
    </p>
  ) : null
}

export function PrimoConversation({
  userName,
  className,
  home = false,
}: {
  userName: string
  className?: string
  home?: boolean
}) {
  const {
    chat,
    route,
    send,
    conversationId,
    conversationLoading,
    conversationError,
    reloadConversation,
    setOpen,
    isDesktop,
  } = usePrimo()
  const { messages, status, error, regenerate, stop } = chat
  const { timezone } = useBusinessSettings()
  const busy = status === "submitted" || status === "streaming"
  const empty = messages.length === 0
  const starterQuestions = home
    ? homeStarterQuestions
    : route.recipeRef
      ? recipeStarterQuestions
      : generalStarterQuestions
  const lastAssistantId = messages.findLast(
    (message) => message.role === "assistant"
  )?.id
  // The reply the SDK appends on send has no text or tool parts yet. Until it
  // does, the working marker stands in for it; drawing its footer early puts
  // a timestamp over an empty row that jumps when the answer lands.
  const lastMessage = messages.at(-1)
  const awaitingReply =
    busy &&
    lastMessage?.role === "assistant" &&
    !lastMessage.parts.some(
      (part) => (part.type === "text" && part.text) || isToolUIPart(part)
    )
  const [editing, setEditing] = React.useState<{
    conversationId: string
    message: PrimoUIMessage
    text: string
    pending: boolean
    error: string
  } | null>(null)
  const activeEdit = editing?.conversationId === conversationId ? editing : null
  async function resendEdit() {
    if (!activeEdit || activeEdit.pending || busy || !activeEdit.text.trim())
      return
    const attempt = { ...activeEdit, pending: true, error: "" }
    setEditing(attempt)
    try {
      await send(
        attempt.text.trim(),
        (attempt.message.metadata?.mentions ?? []).filter((mention) =>
          attempt.text.includes(`@${mention.label}`)
        ),
        attempt.message.metadata?.attachments ?? [],
        attempt.message.id
      )
      setEditing((current) => (current === attempt ? null : current))
    } catch (error) {
      setEditing((current) =>
        current === attempt
          ? {
              ...attempt,
              pending: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Couldn’t resend this question.",
            }
          : current
      )
    }
  }
  const [suggestionError, setSuggestionError] = React.useState("")
  const [copyError, setCopyError] = React.useState("")
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const copyTimer = React.useRef<number | null>(null)
  const announcement = busy
    ? "Primo is answering"
    : error ||
        (lastMessage?.role === "assistant" &&
          primoTurnStatus(lastMessage, {
            errored:
              lastMessage.status === "error" || missingReadAnswer(lastMessage),
            aborted: lastMessage.status === "aborted",
            finishReason: lastMessage.metadata?.finishReason,
          }) === "error")
      ? "Primo’s response was interrupted"
      : lastMessage?.status === "aborted"
        ? "Primo stopped"
        : lastMessage?.role === "assistant"
          ? "Primo answered"
          : ""
  React.useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    []
  )

  async function copyMessage(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setCopyError("Couldn’t copy. Select and copy the text instead.")
      return
    }
    setCopiedId(id)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedId(null), 1_500)
  }

  function sendMessage(
    text: string,
    mentions: PrimoMention[] = [],
    attachments: PrimoAttachment[] = []
  ) {
    if (!busy)
      return attachments.length
        ? send(text, mentions, attachments)
        : send(text, mentions)
  }

  async function sendSuggestion(text: string, mentions: PrimoMention[] = []) {
    setSuggestionError("")
    try {
      await sendMessage(text, mentions)
    } catch {
      setSuggestionError("Couldn’t send that question. Try the choice again.")
    }
  }

  if (conversationLoading)
    return (
      <div
        className="mx-auto grid min-h-0 w-full max-w-[760px] flex-1 place-items-center"
        aria-busy="true"
      >
        <Spinner delayed label="Loading conversation" />
      </div>
    )

  return (
    <div
      className={cn(
        "group/primo mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col bg-background",
        empty && !conversationError && "justify-center",
        className
      )}
      aria-busy={conversationLoading || undefined}
    >
      {conversationError ? (
        <div role="alert" className="p-6 text-center">
          <p>{conversationError}</p>
          <Button
            className="mt-3"
            variant="secondary"
            onClick={reloadConversation}
          >
            <RotateCcw aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
      {empty && !conversationError ? (
        <div className="px-4 pb-5 text-center max-md:group-has-[textarea:focus]/primo:hidden">
          {/* The rail greets with the Primo glyph; the home screen is already
              the Chat tab, so the greeting stands on its own there. */}
          {home ? null : (
            <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-muted">
              <HatGlasses
                className="size-6"
                strokeWidth={1.7}
                aria-hidden="true"
              />
            </div>
          )}
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {home
              ? "How can I help in the kitchen?"
              : `Hey there${userName ? `, ${userName.split(" ")[0]}` : ""}`}
          </h1>
        </div>
      ) : null}
      {!empty || busy ? (
        <MessageScroller key={conversationId}>
          {messages.map((message) => (
            <MessageScrollerItem key={message.id} messageId={message.id}>
              {awaitingReply && message.id === lastMessage?.id ? null : (
                <div className="group space-y-3">
                  {activeEdit?.message.id === message.id ? (
                    <form
                      className="space-y-3 rounded-xl border border-border p-4"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void resendEdit()
                      }}
                    >
                      <label
                        className="block text-md font-medium"
                        htmlFor={`edit-${message.id}`}
                      >
                        Edit question
                      </label>
                      <Textarea
                        id={`edit-${message.id}`}
                        autoFocus
                        value={activeEdit.text}
                        maxLength={4000}
                        disabled={activeEdit.pending}
                        onChange={(event) =>
                          setEditing({
                            ...activeEdit,
                            text: event.target.value,
                          })
                        }
                      />
                      <p className="text-md text-muted-foreground">
                        Resending replaces this question and removes all later
                        messages. This question’s attached files are kept.
                      </p>
                      {activeEdit.error ? (
                        <p role="alert" className="text-md text-destructive">
                          {activeEdit.error}
                        </p>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={activeEdit.pending}
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          pending={activeEdit.pending}
                          disabled={!activeEdit.text.trim()}
                        >
                          Save and resend
                        </Button>
                      </div>
                    </form>
                  ) : null}
                  {message.parts.map((part, index) => {
                    if (
                      activeEdit?.message.id === message.id &&
                      part.type === "text"
                    )
                      return null
                    if (part.type === "text" && part.text) {
                      return (
                        <Message
                          key={index}
                          from={message.role === "user" ? "user" : "assistant"}
                        >
                          <Bubble
                            from={
                              message.role === "user" ? "user" : "assistant"
                            }
                          >
                            {message.role === "user" ? (
                              highlightedText(
                                part.text,
                                message.metadata?.mentions ?? []
                              )
                            ) : (
                              <PrimoMarkdown text={part.text} />
                            )}
                          </Bubble>
                        </Message>
                      )
                    }
                    if (!isToolUIPart(part)) return null
                    const toolName = getToolName(part)
                    if (part.state === "output-error") return null
                    if (part.state !== "output-available") {
                      if (!busy || message.id !== lastMessage?.id) return null
                      let line =
                        toolName === "show_recipe_batch"
                          ? "Preparing batch preview…"
                          : toolName in KITCHEN_TOOL_ACTION_LINES
                            ? KITCHEN_TOOL_ACTION_LINES[
                                toolName as keyof typeof KITCHEN_TOOL_ACTION_LINES
                              ]
                            : toolName === "search_usda_foods"
                              ? "Searching USDA FoodData Central…"
                              : toolName === "read_attachment"
                                ? "Reading attachment…"
                                : "Preparing a recipe draft…"
                      if (
                        toolName === "show_recipe_batch" &&
                        "input" in part &&
                        part.input &&
                        typeof part.input === "object" &&
                        "portions" in part.input &&
                        typeof part.input.portions === "number"
                      ) {
                        line = `Preparing a preview for ${quantityFormat.format(part.input.portions)} portions…`
                      }
                      return (
                        <Marker key={part.toolCallId} live>
                          {line}
                        </Marker>
                      )
                    }
                    const output = part.output
                    if (
                      output &&
                      typeof output === "object" &&
                      "ok" in output &&
                      output.ok === false
                    ) {
                      return null
                    }
                    if (
                      toolName === "find_recipes" ||
                      toolName === "find_products"
                    ) {
                      return (
                        <AmbiguityChoices
                          key={part.toolCallId}
                          result={
                            output as FindRecipesResult | FindProductsResult
                          }
                          onChoose={sendSuggestion}
                          disabled={busy || Boolean(activeEdit)}
                        />
                      )
                    }
                    if (toolName === "show_recipe_batch") {
                      return (
                        <BatchLine
                          key={part.toolCallId}
                          result={output as RecipeBatchResult}
                        />
                      )
                    }
                    if (toolName === "get_recipe_cost_change") {
                      return (
                        <PrimoCostLinks
                          key={part.toolCallId}
                          result={output as CostResult}
                          onSuggestion={sendSuggestion}
                        />
                      )
                    }
                    if (toolName === "revise_recipe_draft") {
                      const result = output as {
                        draft: RecipeDraft
                        changes: string[]
                      }
                      return (
                        <div key={part.toolCallId} className="space-y-2">
                          <p className="text-md text-muted-foreground">
                            {result.changes.join(" ")}
                          </p>
                          <PrimoRecipeDraftCard draft={result.draft} />
                        </div>
                      )
                    }
                    if (toolName === "draft_recipe") {
                      return (
                        <PrimoRecipeDraftCard
                          key={part.toolCallId}
                          draft={output as RecipeDraft}
                        />
                      )
                    }
                    return null
                  })}
                  {message.metadata?.attachments?.length ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      {message.metadata.attachments.map((file) => (
                        <PrimoAttachmentPreview
                          key={file.id}
                          file={file}
                          conversationId={conversationId}
                        />
                      ))}
                    </div>
                  ) : null}
                  {message.parts.filter(isToolUIPart).map((part) => {
                    const output =
                      part.state === "output-available" ? part.output : null
                    if (
                      getToolName(part) === "get_recipe_cost_change" ||
                      !output ||
                      typeof output !== "object" ||
                      !("view" in output) ||
                      typeof output.view !== "string" ||
                      !/^\/(?:recipes\/|products\/|analytics(?:\?|$)|ingredients(?:\?|$))/.test(
                        output.view
                      )
                    )
                      return null
                    return (
                      <GuardedLink
                        key={part.toolCallId}
                        href={output.view}
                        onClick={() => {
                          if (isDesktop) setOpen(true)
                        }}
                        className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-md"
                      >
                        <ArrowUpRight className="size-4" aria-hidden="true" />
                        {getToolName(part) === "show_recipe_batch"
                          ? "View batch preview"
                          : output.view.startsWith("/recipes/")
                            ? "Open recipe"
                            : output.view.startsWith("/products/")
                              ? "Open product"
                              : output.view.startsWith("/analytics")
                                ? "View sales report"
                                : "Open ingredients"}
                      </GuardedLink>
                    )
                  })}
                  {message.role === "assistant" &&
                  !(busy && message.id === lastMessage?.id) ? (
                    <TurnStatus
                      message={message}
                      transportError={Boolean(
                        error && message.id === lastMessage?.id
                      )}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "flex min-h-7 items-center gap-1 text-muted-foreground",
                      message.role === "user" && "justify-end"
                    )}
                  >
                    {message.createdAt || message.metadata?.createdAt ? (
                      <time
                        className="mr-1 text-md text-muted-foreground"
                        dateTime={new Date(
                          message.createdAt ?? message.metadata!.createdAt!
                        ).toISOString()}
                      >
                        {formatDayMonthTime(
                          new Date(
                            message.createdAt ?? message.metadata!.createdAt!
                          ),
                          timezone
                        )}
                      </time>
                    ) : null}
                    {!busy ? (
                      <>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={
                            message.role === "user"
                              ? "Copy message"
                              : "Copy response"
                          }
                          onClick={() =>
                            void copyMessage(
                              message.id,
                              primoMessageText(message)
                            )
                          }
                        >
                          {copiedId === message.id ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Copy aria-hidden="true" />
                          )}
                        </Button>
                        {message.role === "user" ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Edit question"
                            disabled={Boolean(activeEdit)}
                            onClick={() =>
                              setEditing({
                                conversationId,
                                message,
                                text: primoMessageText(message),
                                pending: false,
                                error: "",
                              })
                            }
                          >
                            <SquarePen aria-hidden="true" />
                          </Button>
                        ) : null}
                        {message.role === "assistant" ? (
                          <PrimoFeedback
                            key={message.id}
                            conversationId={conversationId}
                            message={message}
                          />
                        ) : null}
                        {message.role === "assistant" &&
                        message.id === lastAssistantId &&
                        message.id === lastMessage?.id ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={
                              error ||
                              missingReadAnswer(message) ||
                              primoTurnStatus(message, {
                                errored: message.status === "error",
                                aborted: message.status === "aborted",
                                finishReason: message.metadata?.finishReason,
                              }) === "error"
                                ? "Retry response"
                                : "Regenerate response"
                            }
                            disabled={Boolean(activeEdit)}
                            onClick={() => void regenerate()}
                          >
                            <RotateCcw aria-hidden="true" />
                          </Button>
                        ) : null}
                        {home && error && message.id === lastMessage?.id ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            render={<GuardedLink href="/analytics" />}
                          >
                            Open Analytics
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </MessageScrollerItem>
          ))}
          {status === "submitted" ||
          awaitingReply ||
          (busy &&
            lastMessage?.role === "assistant" &&
            missingReadAnswer(lastMessage)) ? (
            <WorkingMarker />
          ) : null}
          {error && lastMessage?.role !== "assistant" ? (
            <div className="rounded-lg bg-destructive-fill px-3 py-2.5 text-md leading-5 text-destructive">
              <p>Primo couldn’t finish this question. Retry to continue.</p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={Boolean(activeEdit)}
                onClick={() => void regenerate()}
                className="mt-1 text-destructive hover:text-destructive"
              >
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
                Retry
              </Button>
              {home ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="mt-1"
                  render={<GuardedLink href="/analytics" />}
                >
                  Open Analytics
                </Button>
              ) : null}
            </div>
          ) : null}
        </MessageScroller>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {suggestionError ? (
        <p role="alert" className="px-4 text-md text-destructive">
          {suggestionError}
        </p>
      ) : null}
      {copyError ? (
        <p role="alert" className="px-4 text-md text-destructive">
          {copyError}
        </p>
      ) : null}
      <PrimoComposer
        key={`composer-${conversationId}`}
        recipeOpen={route.recipeRef !== null}
        busy={busy}
        disabled={
          conversationLoading ||
          Boolean(conversationError) ||
          Boolean(activeEdit)
        }
        onSend={sendMessage}
        onStop={busy ? stop : () => {}}
        conversationId={conversationId}
      />
      {empty && !conversationError ? (
        <div className="mt-6 px-3 pb-5 max-md:group-has-[textarea:focus]/primo:hidden">
          <p className="mb-2 px-1 text-md text-muted-foreground">
            Try one of these
          </p>
          <ul className="flex flex-col gap-1">
            {starterQuestions.map(({ icon: Icon, question }) => (
              <li key={question}>
                <button
                  type="button"
                  disabled={conversationLoading}
                  onClick={() => void sendSuggestion(question)}
                  className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
                    <Icon
                      className="size-4"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>
                  {question}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
