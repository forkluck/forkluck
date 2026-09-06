"use client"

import * as React from "react"
import {
  ArrowUp,
  AtSign,
  Square,
  Plus,
  Upload,
  X,
  RotateCcw,
  FileText,
  LoaderCircle,
} from "lucide-react"

import { runKitchenToolAction } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Textarea } from "@/components/ui/textarea"
import type { PrimoMention } from "@/lib/primo/messages"
import { PrimoAttachmentPreview } from "./primo-attachment-preview"
import { usePrimoDraft } from "./primo-drafts"
import {
  ATTACHMENT_ACCEPT,
  type PrimoAttachment,
} from "@/lib/primo/attachments"
import { resolveComposerKey } from "@/lib/primo/composer-keys"

type RecipeChoice = {
  recipeRef: string
  title: string
  kind?: "recipe" | "product"
}
type Trigger = { query: string; start: number; end: number; leading: string }

function mentionTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret)
  const match = before.match(/(?:^|\s)@([^\n]{0,40})$/)
  if (!match || match.index === undefined) return null
  return {
    query: match[1].trimStart(),
    start: match.index,
    end: caret,
    leading: /^\s/.test(match[0]) ? match[0][0] : "",
  }
}

export function PrimoComposer({
  recipeOpen,
  busy,
  disabled = false,
  onSend,
  onStop,
  conversationId = "",
}: {
  recipeOpen: boolean
  busy: boolean
  disabled?: boolean
  onSend: (
    message: string,
    mentions?: PrimoMention[],
    attachments?: PrimoAttachment[]
  ) => void | Promise<void>
  onStop: () => void
  conversationId?: string
}) {
  const [draft, setDraft, attachments] = usePrimoDraft(conversationId)
  const input = draft.text
  const mentions = draft.mentions
  const setInput = (text: string) =>
    setDraft((current) => ({ ...current, text }))
  const setMentions = (update: React.SetStateAction<PrimoMention[]>) =>
    setDraft((current) => ({
      ...current,
      mentions:
        typeof update === "function" ? update(current.mentions) : update,
    }))
  const [sendError, setSendError] = React.useState("")
  const fileInput = React.useRef<HTMLInputElement>(null)
  const filesPending = draft.files.some((file) => file.status !== "ready")

  const [caret, setCaret] = React.useState(0)
  const [matches, setMatches] = React.useState<RecipeChoice[]>([])
  const [highlighted, setHighlighted] = React.useState(0)
  const [searching, setSearching] = React.useState(false)
  const [closedFor, setClosedFor] = React.useState<string | null>(null)
  const fetchedFor = React.useRef<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const trigger = mentionTrigger(input, caret)
  const triggerQuery = trigger?.query.trim() ?? ""
  const triggerKey = trigger ? `${trigger.start}:${trigger.query}` : null
  const listOpen = Boolean(trigger && !busy && closedFor !== triggerKey)
  const listId = React.useId()

  React.useLayoutEffect(() => {
    const field = textareaRef.current
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${Math.min(200, Math.max(36, field.scrollHeight))}px`
  }, [input])

  React.useEffect(() => {
    if (!listOpen || !triggerQuery) return
    const query = triggerQuery
    if (fetchedFor.current === query) return
    let current = true
    const timeout = window.setTimeout(() => {
      setSearching(true)
      void Promise.all([
        runKitchenToolAction("find_recipes", { query }),
        runKitchenToolAction("find_products", { query }),
      ])
        .then(([result, products]) => {
          if (!current) return
          fetchedFor.current = query
          setMatches([
            ...(result.ok && result.tool === "find_recipes"
              ? result.recipes.map((recipe) => ({
                  recipeRef: recipe.recipeRef,
                  title: recipe.title,
                  kind: "recipe" as const,
                }))
              : []),
            ...(products.ok && products.tool === "find_products"
              ? products.products.map((product) => ({
                  recipeRef: product.productRef,
                  title: product.name,
                  kind: "product" as const,
                }))
              : []),
          ])
          setHighlighted(0)
        })
        .catch(() => {
          if (current) setMatches([])
        })
        .finally(() => {
          if (current) setSearching(false)
        })
    }, 200)
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [listOpen, triggerQuery])

  function focusAt(position: number) {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
      setCaret(position)
    })
  }

  /** Drops an `@` at the caret, which opens the recipe and product picker. */
  function startMention() {
    const before = input.slice(0, caret)
    const leading = before && !/\s$/.test(before) ? " " : ""
    const next = `${before}${leading}@${input.slice(caret)}`
    setInput(next)
    setClosedFor(null)
    focusAt(before.length + leading.length + 1)
  }

  function pickRecipe(recipe: RecipeChoice) {
    if (!trigger) return
    const token = `@${recipe.title}`
    const replacement = `${trigger.leading}${token} `
    const next = `${input.slice(0, trigger.start)}${replacement}${input.slice(trigger.end)}`
    const position = trigger.start + replacement.length
    setInput(next)
    setMentions((current) => [
      ...current.filter((mention) => mention.ref !== recipe.recipeRef),
      {
        kind: recipe.kind ?? "recipe",
        label: recipe.title,
        ref: recipe.recipeRef,
      },
    ])
    setMatches([])
    setClosedFor(`${trigger.start}:${recipe.title} `)
    fetchedFor.current = null
    focusAt(position)
  }

  async function submit() {
    const message =
      input.trim() ||
      (draft.files.length ? "Help me understand these attachments." : "")
    if (!message || busy || disabled || filesPending) return
    setSendError("")
    const sentDraft = draft
    const bound = mentions.filter((mention) =>
      message.includes(`@${mention.label}`)
    )
    const files = draft.files.flatMap((file) => (file.item ? [file.item] : []))
    setDraft(() => ({ text: "", mentions: [], files: [] }))
    setInput("")
    setCaret(0)
    setMentions([])
    setMatches([])
    setSearching(false)
    fetchedFor.current = null
    window.requestAnimationFrame(() => textareaRef.current?.focus())
    try {
      await (files.length
        ? onSend(message, bound, files)
        : onSend(message, bound))
    } catch {
      setDraft((current) =>
        current.text || current.files.length ? current : sentDraft
      )
      setSendError("Couldn’t send. Your draft is ready to retry.")
    }
  }

  return (
    <div className="shrink-0 bg-background p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="sr-only"
        aria-label="Attach files"
        tabIndex={-1}
        onChange={(event) => {
          if (!disabled) attachments.add(Array.from(event.target.files ?? []))
          event.target.value = ""
        }}
      />
      {draft.files.length ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {draft.files.map((file) => (
            <div
              key={file.id}
              className="flex max-w-full items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs"
            >
              {file.status === "uploading" || file.status === "reading" ? (
                <LoaderCircle
                  className="size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <FileText className="size-4 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0">
                {file.item ? (
                  <PrimoAttachmentPreview
                    file={file.item}
                    conversationId={conversationId}
                  />
                ) : (
                  <p className="max-w-48 truncate">{file.name}</p>
                )}
                <p role="status" className="text-muted-foreground">
                  {file.error ||
                    (file.status === "uploading"
                      ? "Uploading…"
                      : file.status === "reading"
                        ? "Reading file…"
                        : file.status === "removing"
                          ? "Removing…"
                          : file.item?.coverage || "Ready")}
                </p>
              </div>
              {file.status === "error" && file.file ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Retry ${file.name}`}
                  onClick={() => void attachments.retry(file.id)}
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={disabled}
                pending={file.status === "removing"}
                aria-label={`Remove ${file.name}`}
                onClick={() => void attachments.remove(file.id)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {/* rounded-2xl outside, rounded-lg buttons inside, 8px between: the
          outer corner is the inner radius plus the gap, so the two curves
          share a center. The inset is what keeps this from reading as a
          plain text field. The halo sits behind it, faint at rest and a
          touch stronger while the field has focus. */}
      <div className="group/composer relative">
        <div
          aria-hidden="true"
          className="primo-glow pointer-events-none absolute -inset-2 rounded-2xl opacity-70 blur-lg transition-opacity group-focus-within/composer:opacity-100"
        />
        <div className="relative flex items-end gap-1 rounded-2xl border border-input bg-background py-2 pr-2 pl-4 focus-within:border-foreground">
          {listOpen ? (
            <div
              id={listId}
              role="listbox"
              aria-label="Recipes and products"
              className="absolute right-0 bottom-full left-0 z-40 mb-1 max-h-56 overflow-y-auto rounded-lg border border-popover-border bg-popover p-1.5 text-popover-foreground"
            >
              {matches.length ? (
                matches.map((recipe, index) => (
                  <button
                    key={recipe.recipeRef}
                    id={`${listId}-${index}`}
                    type="button"
                    aria-label={recipe.title}
                    role="option"
                    aria-selected={index === highlighted}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pickRecipe(recipe)}
                    className="flex h-9 w-full items-center rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent aria-selected:bg-accent"
                  >
                    <span className="truncate">
                      {recipe.title}{" "}
                      <span className="text-xs text-muted-foreground">
                        · {recipe.kind ?? "recipe"}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">
                  {searching
                    ? "Finding recipes and products…"
                    : "No recipes or products match that."}
                </p>
              )}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            maxLength={4000}
            disabled={disabled}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault()
                if (!disabled)
                  attachments.add(Array.from(event.clipboardData.files))
              }
            }}
            value={input}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={
              listOpen && matches.length
                ? `${listId}-${highlighted}`
                : undefined
            }
            onChange={(event) => {
              const next = event.target.value.slice(0, 4_000)
              const nextCaret = Math.min(
                event.target.selectionStart ?? next.length,
                next.length
              )
              setInput(next)
              setCaret(nextCaret)
              setClosedFor(null)
              setMentions((current) =>
                current.filter((mention) => next.includes(`@${mention.label}`))
              )
            }}
            onClick={(event) => setCaret(event.currentTarget.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (listOpen && matches.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setHighlighted((index) => (index + 1) % matches.length)
                  return
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setHighlighted((index) =>
                    index <= 0 ? matches.length - 1 : index - 1
                  )
                  return
                }
                if (event.key === "Home") {
                  event.preventDefault()
                  setHighlighted(0)
                  return
                }
                if (event.key === "End") {
                  event.preventDefault()
                  setHighlighted(matches.length - 1)
                  return
                }
                if (
                  resolveComposerKey(
                    {
                      key: event.key,
                      shiftKey: event.shiftKey,
                      keyCode: event.keyCode,
                      isComposing: event.nativeEvent.isComposing,
                    },
                    {
                      pickerOpen: listOpen,
                      hasPickerOptions: matches.length > 0,
                    }
                  ) === "pick"
                ) {
                  event.preventDefault()
                  pickRecipe(matches[highlighted]!)
                  return
                }
              }
              const keyAction = resolveComposerKey(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  keyCode: event.keyCode,
                  isComposing: event.nativeEvent.isComposing,
                },
                { pickerOpen: listOpen, hasPickerOptions: matches.length > 0 }
              )
              if (keyAction === "close") {
                event.preventDefault()
                event.stopPropagation()
                setClosedFor(triggerKey)
                return
              }
              if (event.key === "Backspace") {
                const position = event.currentTarget.selectionStart
                const token = mentions
                  .map((mention) => ({
                    mention,
                    token: `@${mention.label}`,
                  }))
                  .find(({ token }) => input.slice(0, position).endsWith(token))
                if (token) {
                  event.preventDefault()
                  const start = position - token.token.length
                  const next = `${input.slice(0, start)}${input.slice(position)}`
                  setInput(next)
                  setMentions((current) =>
                    current.filter(
                      (mention) => mention.ref !== token.mention.ref
                    )
                  )
                  focusAt(start)
                  return
                }
              }
              if (keyAction === "send") {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={
              recipeOpen
                ? "Ask Primo about this recipe…"
                : "Ask Primo about the kitchen…"
            }
            aria-label="Message Primo"
            className="max-h-[200px] min-h-9 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-lg leading-6 shadow-none focus-visible:ring-0 md:text-md"
            rows={1}
          />
          <span className="sr-only" aria-live="polite">
            {listOpen && !searching ? `${matches.length} matches found.` : ""}
          </span>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label="Add to message"
                  className="mb-1 shrink-0"
                />
              }
            >
              <Plus aria-hidden="true" />
            </MenuTrigger>
            {/* The composer sits at the foot of the screen, so the menu opens
              upward. Focus goes back to the field, not the plus, because
              both rows continue the draft. */}
            <MenuContent side="top" className="w-52" finalFocus={textareaRef}>
              <MenuItem onClick={() => fileInput.current?.click()}>
                <Upload strokeWidth={1.8} aria-hidden="true" />
                Upload from device
              </MenuItem>
              <MenuItem onClick={startMention}>
                <AtSign strokeWidth={1.8} aria-hidden="true" />
                Mention
                <kbd className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
                  @
                </kbd>
              </MenuItem>
            </MenuContent>
          </Menu>
          {busy ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={onStop}
              aria-label="Stop Primo"
              className="mb-1 shrink-0"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              onClick={submit}
              disabled={
                disabled ||
                (!input.trim() && !draft.files.length) ||
                filesPending
              }
              aria-label="Send message"
              // The one filled button that is brand blue rather than ink. Pale
              // while there is nothing to send, full blue once there is.
              className="mb-1 shrink-0 border-brand bg-brand text-brand-foreground hover:border-brand/85 hover:bg-brand/85 disabled:border-brand/40 disabled:bg-brand/40 disabled:text-brand-foreground"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      {draft.fileErrors?.length ? (
        <ul role="alert" className="mt-2 space-y-1 text-xs text-destructive">
          {draft.fileErrors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      ) : null}
      {sendError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {sendError}
        </p>
      ) : null}
      <p className="mt-1.5 px-1 text-2xs leading-4 text-faint">
        Primo can make mistakes. Forkluck cards come from your kitchen data.
      </p>
    </div>
  )
}
