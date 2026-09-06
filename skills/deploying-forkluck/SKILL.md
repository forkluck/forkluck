---
name: deploying-forkluck
description: Prepare, verify, publish, deploy, or diagnose a Forkluck release. Use when the user explicitly asks to commit, push, release, deploy, check GitHub Actions, inspect the production host, or confirm a live revision.
---

# Deploying Forkluck

Deployment is a separately authorized operation. An implementation request alone does not authorize commits, pushes, releases, server changes, provider changes, or production data writes.

## Establish the exact release

Before publishing:

1. Read `AGENTS.md`, `docs/DEPLOYMENT.md`, and the repository's current workflow files.
2. Inspect the complete worktree and branch. Preserve unrelated user changes; never stage them implicitly.
3. Confirm the intended target branch and whether a pull request is required. Follow the user's explicit branch and PR instruction when it differs from the repository default workflow.
4. Run the repository-prescribed frontend and backend verification. Cross-layer changes require contract checks, migrations, import-linter, build, and relevant browser acceptance coverage.
5. Review the complete diff and identify any schema, worker, environment, secret, protocol, or infrastructure dependency.

Use a short human commit message. Stage only confirmed paths. Report the exact commit SHA that was pushed.

## Follow the release pipeline

Prefer the documented GitHub Actions release path. Observe it through verification, packaging, and deployment; a successful push is not proof of a successful release.

If CI fails:

- inspect the exact failed step and annotation;
- distinguish a code failure from runner, budget, network, or credential infrastructure;
- retry only when the failure condition has changed and retrying is authorized;
- do not bypass a failed verification gate with a manual deployment.

A manual activation is acceptable only when verification and packaging succeeded, the final deploy step was blocked by an external infrastructure condition, the standard artifact is available and verified, the production foundation hashes match, and the user authorized completing the deployment. Use the repository's standard atomic deploy helper rather than recreating its steps.

## Confirm production, not intention

After deployment, verify:

- the live `current` release resolves to the intended full SHA;
- Next.js, Django, configured workers, and the reverse proxy are active;
- restart counts are stable;
- internal frontend/backend health endpoints and the public application answer successfully;
- recent service logs contain no new errors;
- migrations and catalog synchronization reported the expected state.

Use the service names and health routes from the current deployment documentation, not remembered names from an older release.

Stop after the requested release is healthy. Do not use a deployment check as permission to alter production recipes, users, billing, integrations, or other operational data.
