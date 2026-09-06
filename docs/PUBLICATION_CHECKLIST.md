# Preparing a public baseline

The application, AI adapters, supplier connector source, mail provider,
ingredient catalog, and agent skills are intended to be public. Marketing
working files and private operational data remain separate. Public source does
not make accounts, passwords, supplier sessions, documents, or deployment
configuration public.

## Source boundaries

| Source | Where | Intended source visibility | Runtime boundary |
| --- | --- | --- | --- |
| Forkluck app and API | This repository, `apps/web` and `apps/api` | Public, AGPL-3.0-or-later | App UI, AI adapters, authenticated domain API |
| Connectors | This repository, `services/connectors` | Public, AGPL-3.0-or-later | Dedicated credential store, API, worker, database |
| Catalog | This repository, `data/catalog` | Public, CC0 | Authoritative dataset, read by the app at build and run time |
| Agent skills | This repository, `skills` | Public, AGPL-3.0-or-later | Portable contributor guidance |
| Azure mail provider | Separate repository | Public, MIT | Newsletter delivery; preserve upstream copyright notices |
| Marketing | Separate repository | Private | Website source, campaigns, and business working material |

A clean baseline has one parentless commit on `main`. Git history cleanup does
not change the database migration chain: keep the migrations required by fresh
installs and deployed databases. Do not copy the private history archive into
a public repository.

## Before committing

- Review the exact source snapshot, including fixtures, screenshots, licenses,
  workflows, and configuration examples.
- Exclude environment files, customer/production exports, databases, supplier
  captures, local research, build output, and agent worktrees.
- Run `scripts/audit-public-snapshot` on a source export. It checks unsafe paths
  and scans for credentials. Secret scanning does not establish that a dataset
  or screenshot is synthetic; review their provenance too.
- Run the documented checks in each changed repository. Verify the app from
  a fresh source tree with synthetic data and without paid provider accounts.
- Confirm that provider-specific acquisition stays in the connector service
  and that the protocol document, schema, consumer, and service agree.

## Before publishing to GitHub

- Verify the destination and intended visibility of each repository, including
  downloadable archives and any old branches or tags.
- Keep PR execution on GitHub-hosted runners with read-only permissions and no
  deployment secrets. Keep trusted deployment jobs restricted to `main` and
  their configured production environment.
- Review any credential finding and rotate an exposed credential before
  publication. Removing a value from the new tree cannot revoke it.
- Preserve third-party license and attribution requirements, and keep the
  project's contribution licensing policy explicit.
- Inspect the remote tree and reachable history after pushing. A local baseline
  does not replace remote history or change repository visibility.

Committing, pushing, changing visibility, and deploying are separate actions.
A baseline preparation run records which of those it actually performed.
