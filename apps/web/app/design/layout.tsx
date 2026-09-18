import type { Metadata } from "next"

const TITLE = "Forkluck components"
const DESCRIPTION =
  "Every Forkluck component, every variant, rendered live from the app's own code."
const URL = "https://design.forkluck.com/"

export const metadata: Metadata = {
  // Absolute, because the root layout's template appends " — Forkluck" and
  // this page carries the product name in its own title already.
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
}

/**
 * Chrome for the component guide: a slim sticky bar naming the app and the
 * page, and a one-line footer. Everything between them is the page itself,
 * on the bare background, on the app's own tokens.
 *
 * The wordmark carries the same classes as `components/brand-mark.tsx` rather
 * than the component, because the bar wants the type and not the truncating
 * block the sidebar needs.
 */
export default function DesignLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tracking-[-0.01em]">
            Forkluck
          </span>
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          <span className="text-md text-muted-foreground">Components</span>
        </div>
        <a
          href="https://app.forkluck.com"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Open app
        </a>
      </header>
      {children}
      <footer className="flex items-center gap-4 px-6 py-8 text-xs text-muted-foreground">
        <a
          href="https://github.com/forkluck/forkluck"
          className="hover:text-foreground"
        >
          Source
        </a>
        <a href="https://forkluck.com" className="hover:text-foreground">
          Website
        </a>
      </footer>
    </div>
  )
}
