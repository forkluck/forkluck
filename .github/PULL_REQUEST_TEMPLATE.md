## What changed

<!-- Describe the problem and the solution. -->

## Scope

<!-- State the single reviewable outcome and what is deliberately out of scope. -->

In scope:

Out of scope:

## Approval

<!-- Link the issue where this contribution was requested or approved. -->

Related issue: <!-- #123 -->

## Verification

<!-- List the checks you ran and any manual testing. -->

- [ ] Tests added or updated where appropriate
- [ ] `pnpm verify`
- [ ] `pnpm verify:backend`
- [ ] `pnpm test:acceptance`
- [ ] `pnpm verify:connectors` (if `services/connectors/` changed)
- [ ] `pnpm verify:skills` (if `skills/` changed)

## Review focus

<!-- Name concrete risky surfaces: auth/tenant scope, migrations, contracts,
sales attribution, data loss, rollout, or another behavior that could regress. -->

Primary risks:

<!-- Optional improvements belong in a follow-up issue, not this review. -->

## Data and deployment

<!-- Note migrations, configuration changes, rollout concerns, or “None.” -->

- [ ] No credentials, customer data, or private business data are included
- [ ] The pull request is stable, focused, and ready for one complete review pass
- [ ] I agree to the Contributor License Agreement in [CONTRIBUTING.md](CONTRIBUTING.md#contributor-license-agreement)
