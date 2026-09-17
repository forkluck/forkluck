import type * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { LabeledInput, LabeledShell } from "@/components/ui/labeled-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

import { CONTENTS, SECTIONS } from "./demos"

/** Every row of the tokens table, values as declared in `app/globals.css`. */
const TOKENS: { token: string; value: string; changes: string }[] = [
  { token: "--background", value: "#ffffff", changes: "Page and card surface" },
  {
    token: "--foreground",
    value: "#18181b",
    changes: "Body ink, and the fill of a primary button",
  },
  {
    token: "--muted-foreground",
    value: "#52525b",
    changes: "Secondary text, labels, table cells that are not the subject",
  },
  {
    token: "--faint",
    value: "#71717a",
    changes: "Placeholders, sub-lines, the unit affix inside a field",
  },
  {
    token: "--ink-soft",
    value: "#3f3f46",
    changes: "Table headers, and the hover step of the ink button",
  },
  {
    token: "--border",
    value: "#e4e4e7",
    changes: "Every hairline in the app: cards, tables, fields, popovers",
  },
  {
    token: "--line-strong",
    value: "#c9c9cf",
    changes: "The firm-up on hover, and the dashed edge of a drop zone",
  },
  {
    token: "--input",
    value: "var(--border)",
    changes: "A field's edge, named so fields move together",
  },
  {
    token: "--secondary",
    value: "#f4f4f5",
    changes: "The grey pill fill, badges, menu hover",
  },
  {
    token: "--secondary-strong",
    value: "#e4e4e7",
    changes: "The pressed and hovered step of that grey",
  },
  {
    token: "--fill-soft",
    value: "#fbfbfc",
    changes: "Table row hover and inset panels",
  },
  {
    token: "--brand",
    value: "#3273dc",
    changes: "Links, chart marks, selection. Never a button fill",
  },
  {
    token: "--brand-fill",
    value: "#d8e4f7",
    changes: "Progress fills and the solid half of a chart mark",
  },
  { token: "--brand-tile", value: "#e7effb", changes: "The icon tile" },
  {
    token: "--brand-selected",
    value: "#f6f9fe",
    changes: "The fill of a selected card or row",
  },
  {
    token: "--destructive",
    value: "#d92d20",
    changes: "Destructive ink and the filled delete button",
  },
  {
    token: "--destructive-fill",
    value: "#fef8f7",
    changes: "The pale ground a red chip or banner sits on",
  },
  {
    token: "--destructive-strong",
    value: "#b42318",
    changes: "The hover step of that red",
  },
  {
    token: "--success",
    value: "#2f7a4f",
    changes: "A metric moving the right way",
  },
  {
    token: "--success-fill",
    value: "#eaf4ee",
    changes: "The ground under a green chip",
  },
  {
    token: "--warning",
    value: "#c8880c",
    changes: "The needs-attention icon and border ink",
  },
  {
    token: "--warning-foreground",
    value: "#6b4708",
    changes: "Yellow text, dark enough to read on its own fill",
  },
  {
    token: "--warning-fill",
    value: "#fdf8ec",
    changes: "The banner and chip ground",
  },
  {
    token: "--warning-border",
    value: "#f6e6bf",
    changes: "The banner's edge",
  },
  {
    token: "--disabled-foreground",
    value: "#c9c9cf",
    changes: "Disabled text and the inert status dot",
  },
  {
    token: "--ring",
    value: "var(--foreground)",
    changes: "Nothing draws a ring. Focus turns the border ink",
  },
  {
    token: "--radius-sm / md / lg / xl / 2xl",
    value: "4px, 6px, 10px, 14px, 18px",
    changes: "Fields are md, buttons and popovers lg, surfaces xl",
  },
  {
    token: "--shadow-2xs … --shadow-2xl",
    value: "0 0 #0000",
    changes: "There is no elevation. Every shadow resolves to none",
  },
  {
    token: "--text-2xs … --text-4xl",
    value: "11.5, 12.5, 13, 13.5, 14, 16, 17, 24, 26, 42px",
    changes: "Ten steps and nothing between them",
  },
  {
    token: "Control heights",
    value: "20, 24, 28, 32, 36px",
    changes: "Badges, xs, sm, default, lg. 32px is the toolbar hinge",
  },
  {
    token: "--font-body",
    value: "Inter",
    changes: "One face, loaded once in the root layout",
  },
]

/**
 * The visual guide: every Forkluck component rendered live, one section each,
 * in the owner's order, then the tokens they all read from.
 *
 * Synchronous and server-side on purpose. Nothing here fetches, and the date
 * in the byline is a literal, so the page renders the same markup every time
 * and a test can render it in jsdom. The chrome classes are guide.css's, which
 * is article CSS scoped under `.guide` in the layout, and the panes hold the
 * app's real components on the app's own tokens.
 */
export default function DesignGuidePage() {
  return (
    <>
      <header className="art-head">
        <span className="eyebrow">Design system</span>
        <h1>Forkluck visual guide: every component, rendered live</h1>
        <p className="standfirst">
          Every Forkluck component rendered live from the app&apos;s own code,
          with the design tokens behind it.
        </p>
        <div className="byline">
          <span>
            <strong>Forkluck</strong> · September 16, 2026
          </span>
        </div>
      </header>

      <div className="art-hero wide">
        <div className="pane" data-wide="">
          <span className="pane-cap">Forkluck</span>
          <div className="pane-body">
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                  Butter croissant
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline">Duplicate</Button>
                  <Button variant="destructive">Delete</Button>
                  <Button variant="outline" disabled>
                    Archive
                  </Button>
                  <Button>Save recipe</Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="success">On target</Badge>
                <Badge variant="warning">Costed 12 days ago</Badge>
                <Badge>Pastry</Badge>
                <Badge variant="outline">Yields 24</Badge>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <LabeledInput
                  label="Recipe name"
                  defaultValue="Butter croissant"
                  autoComplete="off"
                />
                <LabeledShell label="Status">
                  <Select defaultValue="Published">
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Draft">Draft</SelectItem>
                      <SelectItem value="Published">Published</SelectItem>
                      <SelectItem value="Archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledShell>
              </div>
              <div className="flex flex-wrap items-center gap-6">
                <Field orientation="horizontal">
                  <Switch id="hero-track-inventory" defaultChecked />
                  <FieldLabel htmlFor="hero-track-inventory">
                    Track inventory
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox id="hero-show-costs" defaultChecked />
                  <FieldLabel htmlFor="hero-show-costs">
                    Show costs on the printed sheet
                  </FieldLabel>
                </Field>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="art-grid wide">
        <nav className="toc">
          <span className="toc-h">Contents</span>
          {CONTENTS.map(({ id, title }) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
        </nav>
        <article className="article wide">
          <p>
            This page renders every component in Forkluck from the app&apos;s
            own code: the same files the kitchen screens import, on the same
            tokens, with nothing redrawn for the occasion. Everything is live,
            so hover, focus, and open the menus, popovers and modals. The design
            tokens behind all of it are at the end.
          </p>
          {SECTIONS.map(({ id, title, description, Demo }) => (
            <Section key={id} id={id} title={title} description={description}>
              <Demo />
            </Section>
          ))}
          <h2 id="design-tokens">Design tokens</h2>
          <p>
            The look is a short list of CSS custom properties, and the
            components read them by name rather than spelling values out. Two of
            them are worth saying plainly: there is no elevation anywhere, so
            every shadow token resolves to none, and there is no focus ring,
            because focus turns a control&apos;s border ink instead. Radius has
            five steps, type has ten, and a control stands on one of five
            heights.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Value</th>
                  <th>What it changes</th>
                </tr>
              </thead>
              <tbody>
                {TOKENS.map(({ token, value, changes }) => (
                  <tr key={token}>
                    <td>
                      <code>{token}</code>
                    </td>
                    <td>{value}</td>
                    <td>{changes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            All of these are CSS custom properties declared in{" "}
            <code>app/globals.css</code>, in one place, so a value moves once
            and every screen follows it. A name that reads{" "}
            <code>var(--other)</code> rather than a literal is saying that the
            two are the same colour on purpose.
          </p>
          <p>
            The examples are not screenshots or a separate copy of the library.
            They are the deployed app&apos;s own components, imported by this
            page and rendered on the same tokens, so what you see here is what
            ships.
          </p>
          <p>
            Forkluck is recipe costing and analysis for chefs: it prices a
            recipe from the invoices a kitchen already receives, and keeps that
            price current as the next ones arrive.
          </p>
        </article>
      </div>
    </>
  )
}

/** One article section: the heading, its paragraph, and the captioned pane. */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
      <div className="pane" data-demo={id} data-wide="">
        <span className="pane-cap">Forkluck</span>
        <div className="pane-body">{children}</div>
      </div>
    </>
  )
}
