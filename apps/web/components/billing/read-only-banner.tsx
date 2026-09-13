import Link from "next/link"

import { NoticeBanner, NoticeBannerAction } from "@/components/ui/notice-banner"

/**
 * What a read-only account sees above every screen: the trial or the
 * subscription ended, everything is still here, and the one way back is a
 * subscription. The sentence itself comes from `readOnlyNotice`, so the
 * never-subscribed and lapsed wordings live beside the rest of the billing
 * copy.
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
