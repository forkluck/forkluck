import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { prepareImage } from "@/lib/image-prep"
import {
  extractWithEscalation,
  extractionConfig,
  type ExtractionEngine,
  type ExtractionFile,
} from "@/lib/invoice-extract"
import {
  invoiceExtractionSchema,
  isPurchaseLine,
  normalizeInvoiceExtraction,
  type InvoiceExtraction,
} from "@/lib/invoice-import"
import { parseInvoiceFromTextLines } from "@/lib/invoice-template"
import { extractPdfTextLines } from "@/lib/pdf-text"

import {
  compareExtraction,
  summarize,
  type CaseOutcome,
  type EvalSummary,
} from "./eval/compare"

/**
 * Measures extraction on the owner's own receipts. The golden set holds card
 * digits and addresses, so it lives outside the repository
 * (RECEIPT_GOLDEN_DIR, default ~/forkluck/receipt-golden): one case is a
 * receipt file plus <file>.expected.json in the InvoiceExtraction shape.
 *
 * The free template path runs first on PDFs, exactly as the parse pipeline
 * does, so a Baldor invoice is scored (and bootstrapped) without paying for a
 * model. Everything else goes through extractWithEscalation on the key in the
 * environment — this script never reads Django or the stored credential.
 * `--engine` and `--model` default to what this deployment is configured with.
 *
 *   pnpm eval:extraction --bootstrap
 *   pnpm eval:extraction --engine anthropic --model claude-sonnet-5 --escalate
 */

/** Mirrors DEFAULT_EXPENSE_CATEGORIES in
 * apps/api/forkluck/domains/invoices/actions.py — the names a new workspace
 * gets, which is what the prompt offers in production. */
const CATEGORY_NAMES = [
  "Ingredients",
  "Staff meal",
  "Packaging",
  "Cleaning supplies",
  "Equipment",
  "Repairs",
  "Utilities",
  "Other",
]

const CASE_EXTENSIONS = [".pdf", ".jpg", ".png", ".webp"]

/** USD per million tokens, list price. Qwen is absent on purpose: DashScope
 * pricing is not in this table, so those runs report zero cost. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
}

export type EvalOptions = {
  engine: ExtractionEngine
  model: string | null
  escalate: boolean
  bootstrap: boolean
  only: string | null
  dir: string
}

export type EvalCase = {
  name: string
  filePath: string
  expectedPath: string
  kind: "pdf" | "image"
  hasExpected: boolean
}

export type EvalCaseOutcome = CaseOutcome & { engine: string; model: string }

export type EvalReport = {
  engine: ExtractionEngine
  model: string
  escalate: boolean
  date: string
  cases: EvalCaseOutcome[]
  summary: EvalSummary
}

/** The only place Forkluck reads a key from the environment instead of the
 * workspace, so the error can name the variable that was missing. */
function keyVariable(engine: ExtractionEngine): string {
  return engine === "qwen" ? "QWEN_API_KEY" : "ANTHROPIC_API_KEY"
}

export function defaultGoldenDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RECEIPT_GOLDEN_DIR?.trim()
  return configured || path.join(os.homedir(), "forkluck", "receipt-golden")
}

export function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    // The deployment's own engine, so a bare run scores what production runs.
    engine: extractionConfig().engine,
    model: null,
    escalate: false,
    bootstrap: false,
    only: null,
    dir: defaultGoldenDir(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case "--engine":
        if (value !== "anthropic" && value !== "qwen") {
          throw new Error("--engine takes anthropic or qwen")
        }
        options.engine = value
        index += 1
        break
      case "--model":
        if (!value) throw new Error("--model takes a model id")
        options.model = value
        index += 1
        break
      case "--only":
        if (!value) throw new Error("--only takes a substring")
        options.only = value
        index += 1
        break
      case "--dir":
        if (!value) throw new Error("--dir takes a directory")
        options.dir = value
        index += 1
        break
      case "--escalate":
        options.escalate = true
        break
      case "--bootstrap":
        options.bootstrap = true
        break
      default:
        throw new Error(`Unknown flag ${flag}`)
    }
  }
  return options
}

export function discoverCases(dir: string, only: string | null): EvalCase[] {
  return fs
    .readdirSync(dir)
    .filter((name) =>
      CASE_EXTENSIONS.includes(path.extname(name).toLowerCase())
    )
    .filter((name) => (only ? name.includes(only) : true))
    .sort()
    .map((name) => {
      const expectedPath = path.join(dir, `${name}.expected.json`)
      return {
        name,
        filePath: path.join(dir, name),
        expectedPath,
        kind:
          path.extname(name).toLowerCase() === ".pdf"
            ? ("pdf" as const)
            : ("image" as const),
        hasExpected: fs.existsSync(expectedPath),
      }
    })
}

/** A bootstrapped file carries `draft: true` until the owner has checked it
 * against the receipt; the flag is not part of the extraction shape. */
export function loadExpected(expectedPath: string): {
  expected: InvoiceExtraction
  draft: boolean
} {
  const raw = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as Record<
    string,
    unknown
  >
  const { draft, ...rest } = raw
  return {
    expected: invoiceExtractionSchema.parse(rest),
    draft: draft === true,
  }
}

/** Null for a model this table doesn't price (every Qwen model). */
export function extractionCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number | null {
  const key = Object.keys(MODEL_PRICING).find((name) => model.startsWith(name))
  if (!key) return null
  const price = MODEL_PRICING[key]
  return (
    (usage.inputTokens * price.input + usage.outputTokens * price.output) /
    1_000_000
  )
}

const NOT_USABLE_PREFIX = "This file doesn't look like a supplier invoice: "

/** normalizeInvoiceExtraction refuses a "not usable" document with an error
 * rather than returning it, so the golden bundle case is scored on that
 * refusal instead of on an extraction nobody gets to see. */
export function notUsableFromError(error: string): InvoiceExtraction | null {
  if (!error.startsWith(NOT_USABLE_PREFIX)) return null
  return {
    supplierName: "",
    documentType: "invoice",
    invoiceNumber: null,
    invoiceDate: null,
    totalAmount: null,
    currency: null,
    otherChargesAmount: null,
    dueDate: null,
    subtotalAmount: null,
    taxAmount: null,
    lines: [],
    notUsable: error.slice(NOT_USABLE_PREFIX.length),
  }
}

export function buildReport(
  options: EvalOptions,
  model: string,
  outcomes: EvalCaseOutcome[],
  date: string
): EvalReport {
  return {
    engine: options.engine,
    model,
    escalate: options.escalate,
    date,
    cases: outcomes,
    summary: summarize(outcomes),
  }
}

export function reportPath(
  dir: string,
  engine: string,
  model: string,
  date: string
): string {
  const slug = model.replace(/[^a-z0-9.-]+/gi, "-")
  return path.join(dir, "reports", `${engine}-${slug}-${date}.json`)
}

// --- Running a case --------------------------------------------------------

type Read = {
  extraction: InvoiceExtraction
  engine: string
  model: string
  escalated: boolean
  usage: { inputTokens: number; outputTokens: number }
}

/** The free path: text layer plus the deterministic supplier template. Null
 * when the file is an image, a scan, or a layout the template defers on. */
async function templateRead(
  evalCase: EvalCase,
  base64: string
): Promise<Read | null> {
  if (evalCase.kind !== "pdf") return null
  const text = await extractPdfTextLines(base64)
  if (text.scanned) return null
  const extraction = parseInvoiceFromTextLines(text.pages, text.pageSizes)
  if (!extraction) return null
  return {
    extraction,
    engine: "template",
    model: "text-layer",
    escalated: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

async function modelRead(
  evalCase: EvalCase,
  bytes: Buffer,
  base64: string,
  options: EvalOptions,
  model: string,
  apiKey: string | null
): Promise<Read | { error: string }> {
  const file: ExtractionFile =
    evalCase.kind === "pdf"
      ? { kind: "pdf", mediaType: "application/pdf", base64 }
      : await prepareImage(bytes).then((prepared) => ({
          kind: "image" as const,
          mediaType: prepared.mediaType,
          base64: prepared.base64,
        }))
  const run = await extractWithEscalation(file, CATEGORY_NAMES, {
    engine: options.engine,
    model,
    apiKey,
  })
  if ("error" in run) {
    // A "not usable" verdict is refused upstream, so it arrives as an error;
    // the bundle case is scored on that verdict, not counted as a crash.
    const notUsable = notUsableFromError(run.error)
    if (!notUsable) return run
    return {
      extraction: notUsable,
      engine: options.engine,
      model,
      escalated: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
  return {
    extraction: run.extraction,
    engine: options.engine,
    model: run.model,
    escalated: run.escalated,
    usage: run.usage,
  }
}

async function readCase(
  evalCase: EvalCase,
  options: EvalOptions,
  model: string,
  apiKey: string | null
): Promise<Read | { error: string }> {
  const bytes = fs.readFileSync(evalCase.filePath)
  const base64 = bytes.toString("base64")
  try {
    // A file past the complexity ceilings, or one pdf.js can't open, throws
    // here; it is one failed case, not a failed run.
    const template = await templateRead(evalCase, base64)
    if (template) return template
    if (!apiKey) {
      return {
        error: `No ${keyVariable(options.engine)} in the environment.`,
      }
    }
    return await modelRead(evalCase, bytes, base64, options, model, apiKey)
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

function scoreCase(
  evalCase: EvalCase,
  read: Read | { error: string },
  ms: number,
  fallbackModel: string
): EvalCaseOutcome {
  if ("error" in read) {
    return {
      name: evalCase.name,
      comparison: null,
      reconciled: false,
      escalated: false,
      error: read.error,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ms,
      engine: "-",
      model: fallbackModel,
    }
  }
  const { expected } = loadExpected(evalCase.expectedPath)
  const normalized = normalizeInvoiceExtraction(read.extraction)
  // Scored on the lines the importer keeps, the way the review screen shows
  // them; a footer row the normalizer drops is not a miss.
  const kept = {
    ...read.extraction,
    lines: read.extraction.lines.filter(isPurchaseLine),
  }
  const actual =
    "error" in normalized
      ? (notUsableFromError(normalized.error) ?? kept)
      : kept
  return {
    name: evalCase.name,
    comparison: compareExtraction(expected, actual),
    reconciled:
      "error" in normalized ? false : normalized.totalsMismatch === null,
    escalated: read.escalated,
    error: null,
    inputTokens: read.usage.inputTokens,
    outputTokens: read.usage.outputTokens,
    costUsd: extractionCostUsd(read.model, read.usage) ?? 0,
    ms,
    engine: read.engine,
    model: read.model,
  }
}

// --- Output ----------------------------------------------------------------

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`

function printTable(outcomes: EvalCaseOutcome[]): void {
  const rows = outcomes.map((outcome) => [
    outcome.name.slice(0, 48),
    outcome.engine,
    outcome.error ? "error" : outcome.comparison?.fullyCorrect ? "yes" : "no",
    outcome.comparison ? pct(outcome.comparison.headerFieldAccuracy) : "-",
    outcome.comparison ? pct(outcome.comparison.lineFieldAccuracy) : "-",
    outcome.reconciled ? "yes" : "no",
    outcome.escalated ? "yes" : "no",
    `$${outcome.costUsd.toFixed(4)}`,
    String(Math.round(outcome.ms)),
  ])
  const header = [
    "case",
    "engine",
    "correct",
    "header",
    "lines",
    "recon",
    "esc",
    "cost",
    "ms",
  ]
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length))
  )
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ")
  console.log(line(header))
  console.log(widths.map((width) => "-".repeat(width)).join("  "))
  for (const row of rows) console.log(line(row))
  for (const outcome of outcomes) {
    if (outcome.error) console.log(`${outcome.name}: ${outcome.error}`)
  }
}

// --- Entry point -----------------------------------------------------------

async function bootstrap(
  cases: EvalCase[],
  options: EvalOptions,
  model: string,
  apiKey: string | null
): Promise<void> {
  const needsKey: string[] = []
  for (const evalCase of cases) {
    if (evalCase.hasExpected) continue
    const read = await readCase(evalCase, options, model, apiKey)
    if ("error" in read) {
      needsKey.push(`${evalCase.name}: ${read.error}`)
      continue
    }
    fs.writeFileSync(
      evalCase.expectedPath,
      `${JSON.stringify(
        {
          draft: true,
          ...read.extraction,
          lines: read.extraction.lines.filter(isPurchaseLine),
        },
        null,
        2
      )}\n`
    )
    console.log(
      `wrote ${path.basename(evalCase.expectedPath)} (${read.engine})`
    )
  }
  if (needsKey.length > 0) {
    console.log("\nStill without an expected file:")
    for (const line of needsKey) console.log(`  ${line}`)
  }
  console.log(
    '\nDrafts are not golden: check each one against the receipt and delete its "draft": true.'
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(options.dir)) {
    throw new Error(`No golden set at ${options.dir} (set RECEIPT_GOLDEN_DIR).`)
  }
  // extractWithEscalation reads the tier-3 model from the environment, so the
  // flags are written back before the config is read — that is how the eval
  // runs a single pass, and how --engine picks the right tier-3 default.
  process.env.INVOICE_EXTRACTION_ENGINE = options.engine
  if (options.model) process.env.INVOICE_EXTRACTION_MODEL = options.model
  if (!options.escalate) process.env.INVOICE_ESCALATION_MODEL = ""
  const apiKey = process.env[keyVariable(options.engine)]?.trim() || null
  const model = extractionConfig().model

  const cases = discoverCases(options.dir, options.only)
  console.log(`${cases.length} case(s) in ${options.dir}`)
  if (options.bootstrap) {
    await bootstrap(cases, options, model, apiKey)
    return
  }

  const drafts: string[] = []
  const outcomes: EvalCaseOutcome[] = []
  for (const evalCase of cases) {
    if (!evalCase.hasExpected) {
      console.log(`${evalCase.name}: no expected file — run --bootstrap`)
      continue
    }
    if (loadExpected(evalCase.expectedPath).draft) drafts.push(evalCase.name)
    const started = Date.now()
    const read = await readCase(evalCase, options, model, apiKey)
    outcomes.push(scoreCase(evalCase, read, Date.now() - started, model))
  }

  printTable(outcomes)
  const summary = summarize(outcomes)
  console.log(
    `\n${summary.fullyCorrect}/${summary.documents} fully correct (${pct(summary.fullyCorrectRate)}), ` +
      `header ${pct(summary.headerFieldAccuracy)}, lines ${pct(summary.lineFieldAccuracy)}, ` +
      `reconciled ${pct(summary.reconciledRate)}, escalated ${pct(summary.escalatedRate)}, ` +
      `$${summary.costUsd.toFixed(4)}, ${Math.round(summary.meanMs)} ms mean`
  )
  if (options.engine === "qwen") {
    console.log("Cost reads $0: DashScope pricing is not in the table.")
  }
  if (drafts.length > 0) {
    console.log(
      `Not golden yet — ${drafts.length} expected file(s) still marked "draft": ${drafts.join(", ")}`
    )
  }

  const date = new Date().toISOString().slice(0, 10)
  const report = reportPath(options.dir, options.engine, model, date)
  fs.mkdirSync(path.dirname(report), { recursive: true })
  fs.writeFileSync(
    report,
    `${JSON.stringify(buildReport(options, model, outcomes, date), null, 2)}\n`
  )
  console.log(`report ${report}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
