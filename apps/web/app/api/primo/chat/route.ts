import { createHash } from "node:crypto"
import { primoAttachmentManifest } from "@/lib/primo/attachment-server"
import {
  ATTACHMENT_TEXT_LIMIT,
  type PrimoAttachment,
} from "@/lib/primo/attachments"
import { sameOrigin } from "@/lib/primo/origin"
import { NextResponse } from "next/server"
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  streamText,
  validateUIMessages,
  type UIMessage,
} from "ai"
import { z } from "zod"

import { getSession } from "@/lib/auth-session"
import { BackendRequestError, djangoAction } from "@/lib/backend/client"
import { primoAvailable } from "@/lib/primo/access"
import {
  primoModel,
  primoGenerationLimits,
  QWEN_MODEL,
} from "@/lib/primo/model"
import {
  fitPrimoMessages,
  primoMessageCharacters,
  primoMessageMetadataSchema,
  primoMessageText,
  primoTurnStatus,
  sanitizePrimoMessages,
  type PrimoUIMessage,
} from "@/lib/primo/messages"
import { primoInstructions } from "@/lib/primo/prompt"
import { repairPrimoRecipeToolCall } from "@/lib/primo/recipe"
import { createPrimoTools, kitchenToday } from "@/lib/primo/tools"
import { PRODUCT_REF, RECIPE_REF } from "@/lib/primo/kitchen-tools"

export const maxDuration = 100

const requestSchema = z.strictObject({
  conversationId: z.uuid(),
  parentMessageId: z.string().max(64).default(""),
  recipeRef: z.string().regex(RECIPE_REF).nullable(),
  productRef: z.string().regex(PRODUCT_REF).nullable().default(null),
  messages: z.array(z.unknown()).max(200),
})

function cleanTitle(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/^["'“”]+|["'“”\.]+$/g, "")
    .trim()
  return (cleaned || fallback.trim().slice(0, 60) || "New chat").slice(0, 200)
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  const requestId = crypto.randomUUID()
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  }
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    )
  }
  if (!primoAvailable(session.billing)) {
    return NextResponse.json(
      { error: "Primo is not configured." },
      { status: 503 }
    )
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (contentLength > 100_000) {
    return NextResponse.json(
      { error: "That conversation is too long." },
      { status: 413 }
    )
  }

  let body: unknown
  try {
    const rawBody = await request.text()
    if (rawBody.length > 100_000) {
      return NextResponse.json(
        { error: "That conversation is too long." },
        { status: 413 }
      )
    }
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That Primo request is malformed." },
      { status: 400 }
    )
  }

  let messages: UIMessage[]
  let validatedMessages: PrimoUIMessage[]
  let mentions: NonNullable<PrimoUIMessage["metadata"]>["mentions"] = []
  try {
    validatedMessages = await validateUIMessages<PrimoUIMessage>({
      messages: parsed.data.messages,
      metadataSchema: primoMessageMetadataSchema.optional(),
    })
    mentions = validatedMessages.flatMap((message) =>
      message.role === "user" ? (message.metadata?.mentions ?? []) : []
    )
    const sanitized = sanitizePrimoMessages(validatedMessages)
    if (
      primoMessageCharacters(
        sanitized.filter((message) => message.role === "user")
      ).some((size) => size > 4_000)
    ) {
      throw new Error("Message too long")
    }
    messages = sanitizePrimoMessages(fitPrimoMessages(validatedMessages))
  } catch {
    return NextResponse.json(
      { error: "That conversation couldn't be read." },
      { status: 400 }
    )
  }

  if (messages.length === 0) {
    return NextResponse.json(
      { error: "That conversation is too long." },
      { status: 400 }
    )
  }

  const lastUserMessage = validatedMessages.findLast(
    (message) => message.role === "user"
  )
  if (!lastUserMessage) {
    return NextResponse.json(
      { error: "That conversation couldn't be read." },
      { status: 400 }
    )
  }
  let responseMessageId = createHash("sha256")
    .update(`${parsed.data.conversationId}:${lastUserMessage.id}`)
    .digest("hex")
  try {
    const saved = await djangoAction<{ responseMessageId?: string }>(
      "primo-save-turn",
      {
        conversationId: parsed.data.conversationId,
        messages: [
          {
            id: lastUserMessage.id,
            role: "user",
            parts: lastUserMessage.parts.filter((part) => part.type === "text"),
            text: primoMessageText(lastUserMessage),
            status: "complete",
            metadata: {
              mentions: lastUserMessage.metadata?.mentions ?? [],
              attachmentIds: lastUserMessage.metadata?.attachmentIds ?? [],
            },
            parentMessageId: parsed.data.parentMessageId,
          },
        ],
      }
    )
    responseMessageId = saved?.responseMessageId || responseMessageId
  } catch (cause) {
    const status =
      cause instanceof BackendRequestError &&
      cause.message === "Conversation not found"
        ? 404
        : 502
    return NextResponse.json(
      {
        error:
          status === 404
            ? "Conversation not found"
            : "Primo couldn't save that message.",
      },
      { status }
    )
  }

  // Collect references from all accepted user turns, before history fitting can
  // hide their messages. Server summaries, never browser summaries, form the manifest.
  let attachments: PrimoAttachment[]
  try {
    const ids = [
      ...new Set(
        [...validatedMessages]
          .reverse()
          .flatMap((message) =>
            message.role === "user"
              ? (message.metadata?.attachmentIds ?? [])
              : []
          )
      ),
    ]
    attachments = await primoAttachmentManifest(ids, parsed.data.conversationId)
    if (JSON.stringify(attachments).length > ATTACHMENT_TEXT_LIMIT)
      return NextResponse.json(
        {
          error:
            "This chat has too many attachments. Start a new chat to continue.",
        },
        { status: 400 }
      )
  } catch {
    return NextResponse.json(
      {
        error:
          "An attachment is no longer available. Attach it again or start a new chat.",
      },
      { status: 400 }
    )
  }
  const tools = createPrimoTools({
    recipeRef: parsed.data.recipeRef,
    productRef: parsed.data.productRef,
    mentions,
    conversationId: parsed.data.conversationId,
    attachments,
  })

  let generatedTitle = ""
  let generationErrored = false
  const limits = primoGenerationLimits(attachments.length > 0)
  const deadline = AbortSignal.timeout(limits.timeoutMs)
  const needsTitle =
    validatedMessages.filter((message) => message.role === "user").length === 1
  try {
    const result = streamText({
      model: primoModel(),
      instructions: primoInstructions(await kitchenToday(), {
        recipeRef: parsed.data.recipeRef,
        productRef: parsed.data.productRef,
        mentions,
        attachments,
      }),
      messages: await convertToModelMessages(messages, {
        tools,
        ignoreIncompleteToolCalls: true,
      }),
      tools,
      toolChoice: "auto",
      experimental_repairToolCall: repairPrimoRecipeToolCall,
      stopWhen: isStepCount(limits.maxSteps),
      maxOutputTokens: limits.maxOutputTokens,
      abortSignal: AbortSignal.any([request.signal, deadline]),
      providerOptions: {
        qwen: { enable_thinking: false },
      },
      onEnd: ({ finishReason }) => {
        console.info("primo_request", {
          requestId,
          model: QWEN_MODEL,
          durationMs: Date.now() - startedAt,
          finishReason,
          timedOut: deadline.aborted,
        })
      },
      onError: () => {
        generationErrored = true
      },
    })
    const stream = createUIMessageStream<PrimoUIMessage>({
      generateId: () => responseMessageId,
      originalMessages: validatedMessages,
      execute: async ({ writer }) => {
        writer.merge(
          result
            .toUIMessageStream<PrimoUIMessage>({
              generateMessageId: () => responseMessageId,
              messageMetadata: ({ part }) =>
                part.type === "start"
                  ? { createdAt: new Date().toISOString() }
                  : part.type === "finish"
                    ? { finishReason: part.finishReason }
                    : undefined,
            })
            .pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  // A server deadline is a retryable failure, not the user's Stop.
                  controller.enqueue(
                    part.type === "abort" && deadline.aborted
                      ? {
                          type: "error",
                          errorText:
                            "Primo ran out of time preparing this response. Try again.",
                        }
                      : part
                  )
                },
              })
            )
        )
        if (!needsTitle) return
        const fallback = primoMessageText(lastUserMessage)
        try {
          const titleResult = await generateText({
            model: primoModel(),
            prompt:
              "Name this kitchen conversation in at most six words, no quotes, no trailing period.\n\n" +
              fallback,
            maxOutputTokens: 40,
            abortSignal: AbortSignal.timeout(10_000),
            providerOptions: { qwen: { enable_thinking: false } },
          })
          generatedTitle = cleanTitle(titleResult.text, fallback)
        } catch {
          generatedTitle = cleanTitle("", fallback)
        }
        writer.write({
          type: "data-title",
          data: {
            conversationId: parsed.data.conversationId,
            title: generatedTitle,
          },
        })
      },
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        try {
          await djangoAction("primo-save-turn", {
            conversationId: parsed.data.conversationId,
            ...(generatedTitle ? { title: generatedTitle } : {}),
            messages: [
              {
                id: responseMessage.id,
                role: "assistant",
                parts: responseMessage.parts,
                text: primoMessageText(responseMessage),
                status: primoTurnStatus(responseMessage, {
                  aborted: isAborted || request.signal.aborted,
                  errored: generationErrored || deadline.aborted,
                  finishReason,
                }),
                metadata: finishReason ? { finishReason } : {},
                parentMessageId: lastUserMessage.id,
              },
            ],
          })
        } catch {
          console.error("primo_save_failed", { requestId })
        }
      },
      onError: () => "Primo couldn't answer that. Try again.",
    })
    return createUIMessageStreamResponse({ stream })
  } catch {
    return NextResponse.json(
      { error: "Primo couldn't answer that. Try again." },
      { status: 502 }
    )
  }
}
