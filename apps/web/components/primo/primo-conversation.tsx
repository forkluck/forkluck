"use client"

import * as React from "react"
import { getToolName, isToolUIPart } from "ai"
import {
  Check,
  Copy,
  HatGlasses,
  RotateCcw,
  ArrowUpRight,
  MessageSquare,
} from "lucide-react"

import { PrimoMarkdown } from "./primo-markdown"
import { PrimoAttachmentPreview } from "./primo-attachment-preview"
import { PrimoFeedback } from "./primo-feedback"
import { type PrimoAttachment } from "@/lib/primo/attachments"
import { GuardedLink } from "@/components/navigation-blocker"
import { LoadingRegion } from "@/components/ui/loading-region"
import { PrimoComposer } from "@/components/primo/primo-composer"
import { usePrimo } from "@/components/primo/primo-provider"
import { PrimoRecipeDraftCard } from "@/components/primo/primo-recipe-draft-card"
import { PrimoResultCard } from "@/components/primo/primo-result-card"
import {
  PrimoUsdaResultCard,
  type PrimoUsdaSearchResult,
} from "@/components/primo/primo-usda-result-card"
import { Bubble } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Marker } from "@/components/ui/marker"
import { Message } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerItem,
} from "@/components/ui/message-scroller"
import type { RecipeCostDiff } from "@/lib/backend/types"
import { KITCHEN_TOOL_ACTION_LINES } from "@/lib/primo/kitchen-tool-client"
import type {
  FindProductsResult,
  FindRecipesResult,
  KitchenToolFailure,
  ProductSalesResult,
  RecipeBatchResult,
} from "@/lib/primo/kitchen-tool-results"
import { primoMessageText, type PrimoMention } from "@/lib/primo/messages"
import type { PrimoRecipeDraft } from "@/lib/primo/recipe"
import { formatCents, quantityFormat } from "@/lib/money"
import { cn } from "@/lib/utils"

type CostResult = RecipeCostDiff & { omittedLines?: number }

const recipeStarterQuestions = [
  "What changed in this recipe?",
  "Why did this cost increase?",
  "Compare this recipe since the start of this year.",
]
const generalStarterQuestions = [
  "Find garlic in the USDA database.",
  "Help me create a recipe.",
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
}: {
  result: FindRecipesResult | FindProductsResult
  onChoose: (text: string, mentions: PrimoMention[]) => void
}) {
  if (!result.ambiguous.length) return null
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

function SalesLine({ result }: { result: ProductSalesResult }) {
  return (
    <Marker>
      {result.product.name} · {result.period.label} ·{" "}
      {quantityFormat.format(result.units)} {result.product.baseUnit} ·{" "}
      {formatCents(result.netSalesCents, result.currencyCode)}
    </Marker>
  )
}

function BatchLine({ result }: { result: RecipeBatchResult }) {
  const details = [
    `${result.recipe.title} at ${result.label}`,
    result.portions === null
      ? null
      : `${quantityFormat.format(result.portions)} portions`,
    result.cost
      ? `${formatCents(result.cost.ingredientTotalCents, result.cost.currencyCode)} batch`
      : null,
    result.cost?.portionCostCents === null || !result.cost
      ? null
      : `${formatCents(result.cost.portionCostCents, result.cost.currencyCode)} per portion`,
    "nothing saved",
  ].filter(Boolean)
  return <Marker>{details.join(" · ")}</Marker>
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
  const busy = status === "submitted" || status === "streaming"
  const empty = messages.length === 0
  const starterQuestions = home
    ? [
        "Help me understand product sales.",
        "What changed in ingredient costs?",
        "Help me create a recipe.",
        "Find a recipe to scale for service.",
      ]
    : route.recipeRef
      ? recipeStarterQuestions
      : generalStarterQuestions
  const lastAssistantId = messages.findLast(
    (message) => message.role === "assistant"
  )?.id
  const [copyError, setCopyError] = React.useState("")
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const copyTimer = React.useRef<number | null>(null)
  const announcement = busy
    ? "Primo is answering"
    : messages.length
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

  return (
    <div
      className={cn(
        "group/primo mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col bg-background",
        empty && !conversationLoading && !conversationError && "justify-center",
        className
      )}
    >
      {conversationLoading ? (
        <LoadingRegion pending label="Loading chat">
          <div className="min-h-48" />
        </LoadingRegion>
      ) : conversationError ? (
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
      {empty && !conversationLoading && !conversationError ? (
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
          <p className="mt-2 text-base text-muted-foreground">
            Ask about your kitchen, or drop a recipe or invoice to read.
          </p>
        </div>
      ) : null}
      {!empty || busy ? (
        <MessageScroller key={conversationId}>
          {messages.map((message) => (
            <MessageScrollerItem key={message.id} messageId={message.id}>
              <div className="group space-y-3">
                {message.parts.map((part, index) => {
                  if (part.type === "text" && part.text) {
                    return (
                      <Message
                        key={index}
                        from={message.role === "user" ? "user" : "assistant"}
                      >
                        <Bubble
                          from={message.role === "user" ? "user" : "assistant"}
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
                  if (part.state === "output-error") {
                    return (
                      <Marker key={part.toolCallId}>
                        {toolName === "draft_recipe"
                          ? "Primo couldn’t prepare that recipe draft."
                          : "Primo couldn’t complete that kitchen read."}
                      </Marker>
                    )
                  }
                  if (part.state !== "output-available") {
                    if (message.status === "aborted") {
                      return <Marker key={part.toolCallId}>Stopped</Marker>
                    }
                    if (
                      !busy ||
                      message.id !== messages.at(-1)?.id ||
                      message.status === "error" ||
                      message.status === "complete"
                    ) {
                      return (
                        <Marker key={part.toolCallId}>
                          {toolName === "draft_recipe"
                            ? "Recipe draft interrupted. Regenerate the response to try again."
                            : "This step was interrupted. Regenerate the response to try again."}
                        </Marker>
                      )
                    }
                    let line =
                      toolName in KITCHEN_TOOL_ACTION_LINES
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
                      line = `Scaling to ${quantityFormat.format(part.input.portions)} portions…`
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
                    return (
                      <Marker key={part.toolCallId}>
                        {(output as KitchenToolFailure).message}
                      </Marker>
                    )
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
                        onChoose={sendMessage}
                      />
                    )
                  }
                  if (toolName === "get_product_sales") {
                    return (
                      <SalesLine
                        key={part.toolCallId}
                        result={output as ProductSalesResult}
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
                      <PrimoResultCard
                        key={part.toolCallId}
                        result={output as CostResult}
                        onSuggestion={sendMessage}
                      />
                    )
                  }
                  if (toolName === "search_usda_foods") {
                    return (
                      <PrimoUsdaResultCard
                        key={part.toolCallId}
                        result={output as PrimoUsdaSearchResult}
                      />
                    )
                  }
                  if (toolName === "draft_recipe") {
                    return (
                      <PrimoRecipeDraftCard
                        key={part.toolCallId}
                        draft={output as PrimoRecipeDraft}
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
                    !output ||
                    typeof output !== "object" ||
                    !("view" in output) ||
                    typeof output.view !== "string" ||
                    !/^\/(recipes|products)\//.test(output.view)
                  )
                    return null
                  return (
                    <GuardedLink
                      key={part.toolCallId}
                      href={output.view}
                      onClick={() => {
                        if (isDesktop) setOpen(true)
                      }}
                      className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-3 text-sm"
                    >
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                      {output.view.startsWith("/recipes/")
                        ? "Open recipe"
                        : "Open product"}
                    </GuardedLink>
                  )
                })}
                {message.status === "aborted" ? (
                  <p className="text-xs text-muted-foreground">
                    Response stopped
                  </p>
                ) : message.status === "error" ? (
                  <p className="text-xs text-destructive">
                    Response interrupted. Try again.
                  </p>
                ) : null}
                <div
                  className={cn(
                    "flex min-h-7 items-center gap-1 text-muted-foreground",
                    message.role === "user" && "justify-end"
                  )}
                >
                  {message.createdAt || message.metadata?.createdAt ? (
                    <time
                      className="mr-1 text-2xs"
                      dateTime={new Date(
                        message.createdAt ?? message.metadata!.createdAt!
                      ).toISOString()}
                    >
                      {new Date(
                        message.createdAt ?? message.metadata!.createdAt!
                      ).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
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
                      {message.role === "assistant" ? (
                        <PrimoFeedback
                          key={message.id}
                          conversationId={conversationId}
                          message={message}
                        />
                      ) : null}
                      {message.role === "assistant" &&
                      message.id === lastAssistantId ? (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Regenerate response"
                          onClick={() => void regenerate()}
                        >
                          <RotateCcw aria-hidden="true" />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </MessageScrollerItem>
          ))}
          {status === "submitted" ? <WorkingMarker /> : null}
          {error ? (
            <div className="rounded-lg bg-destructive-fill px-3 py-2.5 text-md leading-5 text-destructive">
              <p>Primo couldn&apos;t answer that. Try again.</p>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void regenerate()}
                className="mt-1 text-destructive hover:text-destructive"
              >
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : null}
        </MessageScroller>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {copyError ? (
        <p role="alert" className="px-4 text-xs text-destructive">
          {copyError}
        </p>
      ) : null}
      <PrimoComposer
        key={`composer-${conversationId}`}
        recipeOpen={route.recipeRef !== null}
        busy={busy}
        disabled={conversationLoading || Boolean(conversationError)}
        onSend={sendMessage}
        onStop={busy ? stop : () => {}}
        conversationId={conversationId}
      />
      {empty && !conversationLoading && !conversationError ? (
        <div className="px-3 pb-8 max-md:group-has-[textarea:focus]/primo:hidden">
          <p className="mb-3 px-1 text-xs text-muted-foreground">
            Try one of these
          </p>
          <div
            className={cn("grid grid-cols-2 gap-2", home && "sm:grid-cols-4")}
          >
            {starterQuestions.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => void sendMessage(question)?.catch(() => {})}
                className="flex min-h-24 flex-col items-start gap-3 rounded-xl border border-border p-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-foreground"
              >
                <MessageSquare
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>{question}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
