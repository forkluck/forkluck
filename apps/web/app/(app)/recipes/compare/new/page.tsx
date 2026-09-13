import type { Metadata } from "next"

import { CompareScreen, type CompareSearchParams } from "../compare-screen"

export const metadata: Metadata = {
  title: "New comparison",
}

export default function NewComparisonPage({
  searchParams,
}: {
  searchParams: CompareSearchParams
}) {
  return <CompareScreen searchParams={searchParams} />
}
