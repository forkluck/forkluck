import { BrandMark } from "@/components/brand-mark"
import { MARKETING_ORIGIN } from "@/lib/public-site"

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Sign-in copy is prose, not dashboard chrome, so it keeps the 1.5 leading
    // that <body> gives up for the handoff's `font:`-shorthand metric.
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-card px-6 py-24 leading-normal">
      {/* The same mark the sidebar draws, so signing in and being signed in
          share one brand. */}
      <a
        href={MARKETING_ORIGIN}
        aria-label="Forkluck home"
        className="absolute top-14 left-1/2 -translate-x-1/2 rounded-sm outline-none focus-visible:underline focus-visible:underline-offset-4"
      >
        <BrandMark />
      </a>
      <div className="w-full max-w-[21.5rem] md:absolute md:inset-x-0 md:top-[32.7svh] md:mx-auto">
        {children}
      </div>
      <div className="absolute bottom-8 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
        <p>
          Need help?{" "}
          <a
            href="mailto:guero@forkluck.com?subject=Forkluck%20support"
            className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:decoration-foreground"
          >
            guero@forkluck.com
          </a>
        </p>
        <a
          href={MARKETING_ORIGIN}
          className="rounded-sm transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
        >
          &larr; Back to forkluck.com
        </a>
      </div>
    </main>
  )
}
