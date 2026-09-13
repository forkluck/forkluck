import type { Metadata } from "next"

import { CompareScreen, type CompareSearchParams } from "../compare-screen"

export const metadata: Metadata = {
  title: "Compare recipes",
}

export default async function SavedComparisonPage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>
  searchParams: CompareSearchParams
}) {
  const { ref } = await params
  return <CompareScreen searchParams={searchParams} savedRef={ref} />
}
