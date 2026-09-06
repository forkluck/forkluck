# Forkluck agent skills

Agent Skills that teach coding agents Forkluck's non-obvious architecture,
measurement, integration, interface, and release invariants. They deliberately
do not copy `ARCHITECTURE.md`, `docs/CONTRACT.md`, `docs/INGREDIENT_MEASURES.md`,
or other product manuals; they route agents to the versions in this checkout so
product rules have one source of truth. They are licensed with the rest of the
repository under AGPL-3.0-or-later.

| Skill | Use it for |
| --- | --- |
| `building-forkluck` | Cross-layer product features, Django actions, Next.js reads and writes, contracts, authorization, persistence, and workers |
| `costing-forkluck-recipes` | Recipe quantities, units, yields, equivalencies, costing portions, nested recipes, nutrition, and health parity |
| `integrating-forkluck` | POS, supplier, invoice, sales, OAuth, webhook, catalog, and supplier connector work |
| `designing-forkluck-ui` | Chef-facing workflows, responsive UI, editor saves, accessibility, and design-system consistency |
| `deploying-forkluck` | Verification, commits, GitHub Actions, releases, production deployment, and live health checks |

## Local Codex installation

```bash
scripts/install-codex-links.sh
```

This links every skill directory under `${CODEX_HOME:-$HOME/.codex}/skills`.
Existing non-matching paths are never overwritten. The directories follow the
portable Agent Skills layout and can be copied into another compatible agent's
skill directory.

## Validation

`pnpm verify:skills` checks each skill's frontmatter and interface and that
every repository path a skill names still exists. It needs the pinned
dependency:

```bash
python3 -m venv skills/.venv
skills/.venv/bin/pip install -r skills/requirements-dev.txt
skills/.venv/bin/python scripts/validate-skills.py
```

Keep each skill concise. Add a rule only when it changes an agent's decisions,
protects a real product invariant, or routes to authoritative context.
