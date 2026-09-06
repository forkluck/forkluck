import { NextResponse } from "next/server"
import { z } from "zod"

import { getSession } from "@/lib/auth-session"
import {
  getPrimoConversation,
  listPrimoConversations,
} from "@/lib/backend/queries"

const querySchema = z.object({
  id: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  archived: z.enum(["0", "1"]).default("0"),
  q: z.string().trim().max(200).default(""),
})

export async function GET(request: Request) {
  // Transcripts remain readable even if the model or subscription is unavailable.
  const headers = { "Cache-Control": "private, no-store" }
  if (!(await getSession())) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers }
    )
  }
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  )
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid conversation request." },
      { status: 400, headers }
    )
  }
  const { id, page, archived, q } = parsed.data
  try {
    // Both backend queries scope every row to the forwarded authenticated user.
    if (id) {
      const item = await getPrimoConversation(id)
      return NextResponse.json(
        item ? { item } : { error: "Conversation not found" },
        { status: item ? 200 : 404, headers }
      )
    }
    const result = await listPrimoConversations({
      page,
      limit: 50,
      archived: archived === "1",
      query: q,
    })
    return NextResponse.json(result, { headers })
  } catch {
    return NextResponse.json(
      {
        error: id
          ? "Couldn’t load that conversation."
          : "Couldn’t load recent chats.",
      },
      { status: 502, headers }
    )
  }
}
