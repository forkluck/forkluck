import Link from "next/link"

import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"

/**
 * What a free account sees above an operations section: menus, sales,
 * invoices, labor and integrations stay readable, everything made during the
 * trial is still here, and writing there takes a subscription. The sentence
 * is the one the server answers such a write with, passed in by the shell.
 */
export function ReadOnlyBanner({ notice }: { notice: string }) {
  return (
    <NoticeBanner
      className="mb-0"
      action={
        <NoticeBannerAction
          nativeButton={false}
          render={<Link href="/subscribe" />}
        >
          Subscribe
        </NoticeBannerAction>
      }
    >
      {notice}
    </NoticeBanner>
  )
}
