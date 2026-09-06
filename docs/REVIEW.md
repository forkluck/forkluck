# Review workflow

Codex is one more review signal, not an acceptance loop. Tests, CI, repository
rules, and human judgment stay authoritative.

1. Keep the pull request in draft while scope or design is still moving.
2. Fill in the template, including out-of-scope work and the risky surfaces.
3. Run the verification suite and wait for green CI before asking Codex.
4. Ask once, on the stable diff, with `@codex review`. For a targeted re-review,
   name the risk (`@codex review for the invoice migration fix`). Don't keep
   requesting whole-PR reviews.
5. Triage every finding before editing:
   - **Blocking** — a substantiated P0/P1 correctness, data-integrity, security,
     privacy, authorization, contract, or regression issue this PR introduced.
     Fix it, and add regression coverage where practical.
   - **Follow-up** — valid but out of scope. Link an issue instead of growing
     the PR.
   - **Declined** — stylistic, duplicate, obsolete, speculative, or not from
     this PR. Reply with the evidence and resolve it.
6. Batch accepted fixes into one pass. Re-request review only after a material
   change to a blocking risk.

Done means: CI green, no unresolved P0/P1, every thread fixed or answered, and
any required human approval in place. A clean Codex pass is a stop condition —
don't send it the same diff again. Merges stay manual; Codex publishes no
required status check.
