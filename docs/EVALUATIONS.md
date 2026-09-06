# AI evaluations

The normal Vitest, Django, and Playwright suites use mocks and synthetic data.
They verify authorization, tool contracts, extraction handling, accounting,
cancellation, and persisted state without paid inference.

Live evaluations answer a different question: does a configured model still
choose the right tools and read documents usefully? Run them when changing
prompts, model selection, extraction schemas, or provider behavior. A passing
unit suite does not establish live model quality.

## Optional live runs

Export the required key into the shell before running these commands. The eval
scripts read process environment variables; they do not automatically load
Next.js `.env.local` or retrieve credentials from a workspace.

| Command | Inputs and provider |
| --- | --- |
| `pnpm eval:primo` | Synthetic kitchen questions and tool responses; uses `QWEN_API_KEY` and the Primo model |
| `pnpm eval:primo:attachments` | Synthetic recipe/document content and draft assertions; uses the Primo model |
| `pnpm eval:extraction --dir /path/to/local-cases` | Your chosen PDF/image files and expected JSON; uses the configured invoice engine |

These runs can incur provider charges and send their inputs to that provider.
Primo's cases are checked in as synthetic examples. Invoice goldens remain
outside Git: use fabricated documents for shareable results. The extraction
script never reads Django; `--engine anthropic` uses the shell's
`ANTHROPIC_API_KEY`, while Qwen uses `QWEN_API_KEY`.

## Invoice goldens

Each document is paired with `<file>.expected.json` in the invoice extraction
schema. `--bootstrap` drafts missing expected files and can call the model.
Review every field against the source and remove `draft: true` only after that
review. Model-generated expectations are not independent evidence.

Without `--dir`, the script reads `RECEIPT_GOLDEN_DIR` or the existing local
`~/forkluck/receipt-golden` convention. `--only <substring>` narrows the cases;
`--engine`, `--model`, and `--escalate` select the comparison. A supported text
PDF can take the deterministic template path before any model call.

## Reporting a change

Record the source commit, exact model identifier, run date, relevant limits,
case count, and failures. Compare against the same inputs and reviewed
expectations. Include latency and token usage when the script reports them;
keep real receipt content, account data, and credentials out of public reports.
Moving model aliases and provider behavior can change results between runs.

The ownership and confirmation rules live in
[ARCHITECTURE.md](../ARCHITECTURE.md#ai-boundaries) and the HTTP contract.
An evaluation result never relaxes those rules.
