import { CONTENTS, SECTIONS } from "./demos"

/** Every design token, values as declared in `app/globals.css`. */
const TOKENS: { token: string; value: string }[] = [
  { token: "--background", value: "#ffffff" },
  { token: "--foreground", value: "#18181b" },
  { token: "--muted-foreground", value: "#52525b" },
  { token: "--faint", value: "#71717a" },
  { token: "--ink-soft", value: "#3f3f46" },
  { token: "--border", value: "#e4e4e7" },
  { token: "--line-strong", value: "#c9c9cf" },
  { token: "--input", value: "var(--border)" },
  { token: "--secondary", value: "#f4f4f5" },
  { token: "--secondary-strong", value: "#e4e4e7" },
  { token: "--fill-soft", value: "#fbfbfc" },
  { token: "--brand", value: "#3273dc" },
  { token: "--brand-fill", value: "#d8e4f7" },
  { token: "--brand-tile", value: "#e7effb" },
  { token: "--brand-selected", value: "#f6f9fe" },
  { token: "--destructive", value: "#d92d20" },
  { token: "--destructive-fill", value: "#fef8f7" },
  { token: "--destructive-strong", value: "#b42318" },
  { token: "--success", value: "#2f7a4f" },
  { token: "--success-fill", value: "#eaf4ee" },
  { token: "--warning", value: "#c8880c" },
  { token: "--warning-foreground", value: "#6b4708" },
  { token: "--warning-fill", value: "#fdf8ec" },
  { token: "--warning-border", value: "#f6e6bf" },
  { token: "--disabled-foreground", value: "#c9c9cf" },
  { token: "--ring", value: "var(--foreground)" },
  {
    token: "--radius-sm / md / lg / xl / 2xl",
    value: "4px, 6px, 10px, 14px, 18px",
  },
  { token: "--shadow-2xs … --shadow-2xl", value: "0 0 #0000" },
  {
    token: "--text-2xs … --text-4xl",
    value: "11.5, 12.5, 13, 13.5, 14, 16, 17, 24, 26, 42px",
  },
  { token: "Control heights", value: "20, 24, 28, 32, 36px" },
  { token: "--font-body", value: "Inter" },
]

/**
 * The component guide: every Forkluck component laid out on the bare page,
 * one section each, in the owner's order, then the tokens they all read from.
 *
 * Synchronous and server-side on purpose. Nothing here fetches and nothing
 * here is dated, so the page renders the same markup every time and a test
 * can render it in jsdom. The sections are the app's own components, imported
 * rather than redrawn, on the app's own tokens.
 */
export default function DesignGuidePage() {
  return (
    <div className="mx-auto max-w-[1280px] px-6">
      <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-x-14">
        <nav
          aria-label="Contents"
          className="sticky top-20 hidden max-h-[calc(100vh-6rem)] overflow-y-auto md:block"
        >
          <div className="flex flex-col gap-2 py-10">
            {CONTENTS.map(({ id, title }) => (
              <a
                key={id}
                href={`#${id}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {title}
              </a>
            ))}
          </div>
        </nav>
        <div>
          <div className="py-10">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">
              Components
            </h1>
            <p className="text-base text-muted-foreground">
              Every variant of every component, rendered from the app&apos;s own
              code.
            </p>
          </div>
          <div>
            {SECTIONS.map(({ id, title, Demo }) => (
              <section
                key={id}
                id={id}
                className="scroll-mt-20 border-t border-border py-10 first:border-t-0"
              >
                <h2 className="mb-6 text-md font-semibold">{title}</h2>
                <Demo />
              </section>
            ))}
            <section
              id="design-tokens"
              className="scroll-mt-20 border-t border-border py-10 first:border-t-0"
            >
              <h2 className="mb-6 text-md font-semibold">Design tokens</h2>
              <dl className="grid gap-x-10 gap-y-2 md:grid-cols-2">
                {TOKENS.map(({ token, value }) => (
                  <div
                    key={token}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  >
                    <dt>
                      <code className="rounded-sm bg-secondary px-1.5 text-xs">
                        {token}
                      </code>
                    </dt>
                    <dd className="text-sm text-muted-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
