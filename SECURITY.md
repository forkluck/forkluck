# Security Policy

## Supported versions

Security fixes are made on the current `main` branch. Forkluck does not currently maintain older release branches.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion, or pull request.

Use [GitHub's private vulnerability reporting form](https://github.com/forkluck/forkluck/security/advisories/new). If that form is unavailable, email [guero@forkluck.com](mailto:guero@forkluck.com?subject=Forkluck%20security%20report) with the subject “Forkluck security report.” Include reproduction steps, affected versions or commits, impact, and any suggested mitigation. Do not include live credentials or private customer data.

You should receive an acknowledgement within five business days. We will investigate, coordinate a fix and disclosure timeline with you, and credit you if desired.

## Operational secrets

The repository must contain only safe development defaults and placeholders. Production credentials belong in the deployment environment or GitHub encrypted secrets. If you believe a credential has been committed, report it privately even if it appears expired so it can be rotated and removed from history where appropriate.
