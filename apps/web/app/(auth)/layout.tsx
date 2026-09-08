import { BrandMark } from "@/components/brand-mark"
import { MARKETING_ORIGIN } from "@/lib/public-site"

const legalLinkClassName =
  "rounded-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4"

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Sign-in copy is prose, not dashboard chrome, so it keeps the 1.5 leading
    // that <body> gives up for the handoff's `font:`-shorthand metric.
    <main className="relative flex min-h-svh w-full flex-col items-center justify-between bg-card leading-normal">
      {/* The same mark the sidebar draws, so signing in and being signed in
          share one brand. */}
      <a
        href={MARKETING_ORIGIN}
        aria-label="Forkluck home"
        className="absolute top-6 left-1/2 z-10 -translate-x-1/2 rounded-sm outline-none focus-visible:underline focus-visible:underline-offset-4"
      >
        <BrandMark />
      </a>

      {/* The two spacers split the slack, so the column floats a little
          above centre and the legal line stays on the bottom edge. The 96px
          floor keeps the column clear of the wordmark on short screens. */}
      <div className="grow basis-0">
        <div className="h-24" />
      </div>

      <div className="relative flex w-full flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm">{children}</div>
      </div>

      <div className="flex grow basis-0 flex-col justify-end">
        <p className="px-6 py-8 text-center text-xs leading-5 text-faint">
          By continuing, you agree to our{" "}
          <a href={`${MARKETING_ORIGIN}/terms`} className={legalLinkClassName}>
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href={`${MARKETING_ORIGIN}/privacy`}
            className={legalLinkClassName}
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </main>
  )
}
