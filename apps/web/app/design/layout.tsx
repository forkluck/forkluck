import type { Metadata } from "next"

import "./guide.css"
import { NavMenu } from "./nav-menu"

const TITLE = "Forkluck visual guide: every component, rendered live"
const DESCRIPTION =
  "Every Forkluck component rendered live from the app's own code, with the design tokens behind it."
const URL = "https://design.forkluck.com/"
const PUBLISHED = "2026-09-16"

export const metadata: Metadata = {
  // Absolute, because the root layout's template appends " — Forkluck" and
  // this page carries the product name in its own title already.
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
}

// Article structured data, so the guide is indexed as the dated piece of
// writing it is rather than as an application screen.
const ARTICLE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: TITLE,
  description: DESCRIPTION,
  url: URL,
  datePublished: PUBLISHED,
  dateModified: PUBLISHED,
  author: {
    "@type": "Organization",
    name: "Forkluck",
    url: "https://forkluck.com/",
  },
  publisher: {
    "@type": "Organization",
    name: "Forkluck",
    url: "https://forkluck.com/",
  },
}

/**
 * Chrome for the visual guide: the marketing nav and footer the article sits
 * in, and the one place guide.css is imported. The page itself renders the
 * header, the contents rail and the sections inside `children`.
 *
 * The `.guide` wrapper is what scopes every rule in guide.css, so this element
 * has to stay outermost; `landing-only` is the reference's mode for a page
 * with no site sections behind it, which hides the unbuilt nav and footer
 * columns and shows the single link row instead.
 */
export default function DesignLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div data-slot="guide" className="guide">
      <script
        type="application/ld+json"
        // The payload is a literal above, not user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ARTICLE_JSON_LD) }}
      />
      <div className="page landing-only">
        <nav className="nav">
          <a href="https://forkluck.com/" className="brand">
            <span>Forkluck</span>
          </a>
          <div className="nav-right">
            <a href="https://app.forkluck.com" className="nav-open">
              Open app
            </a>
            <a href="https://app.forkluck.com/signup" className="btn nav-cta">
              Start free trial
            </a>
            <NavMenu />
          </div>
        </nav>
        {children}
        <footer className="foot">
          <div className="sec-inner">
            <div className="foot-grid">
              <div className="foot-brand">
                <a href="https://forkluck.com/" className="brand">
                  <span>Forkluck</span>
                </a>
                <p>Recipe costing and analysis for chefs.</p>
                <a href="https://app.forkluck.com/signup" className="btn">
                  Start free trial
                </a>
              </div>
              <div className="foot-mini">
                <a href="https://forkluck.com">Website</a>
                <a href="https://app.forkluck.com">App</a>
                <a href="https://feedback.forkluck.com">Feedback</a>
                <a href="https://github.com/forkluck/forkluck">Source</a>
                <a href="https://forkluck.com/privacy/">Privacy</a>
                <a href="mailto:support@forkluck.com">Support</a>
              </div>
            </div>
            <div className="foot-bottom">
              <span>© Forkluck</span>
              <div>
                <a href="https://forkluck.com/privacy/">Privacy</a>
                <a href="https://forkluck.com/terms/">Terms</a>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
