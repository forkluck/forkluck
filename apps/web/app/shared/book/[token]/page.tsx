import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { GuestBookView } from "@/components/recipes/guest-book-view"
import { getGuestBook } from "@/lib/backend/queries"

// Outside the (app) group on purpose: a guest has no session to gate on.
// A share link is the whole credential: keep it out of search indexes and out
// of the Referer header any link the reader follows next would carry.
export const metadata: Metadata = {
  title: "Shared recipes",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default async function SharedBookPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const book = await getGuestBook(token)
  if (!book) notFound()

  return <GuestBookView book={book} />
}
